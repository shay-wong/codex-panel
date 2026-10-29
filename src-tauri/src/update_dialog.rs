// Native confirmation and installation display adapted from upstream UpdateDialog.
#[cfg(target_os = "macos")]
use dispatch2::{run_on_main, MainThreadBound};
#[cfg(target_os = "macos")]
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyObject, NSObjectProtocol},
    sel, DefinedClass, MainThreadMarker, MainThreadOnly,
};
#[cfg(target_os = "macos")]
use objc2_app_kit::{
    NSAlert, NSApplication, NSButton, NSProgressIndicator, NSProgressIndicatorStyle, NSWindow,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObject, NSSize, NSString};
#[cfg(target_os = "macos")]
use std::{cell::RefCell, sync::Arc};
use tauri::{AppHandle, Manager, WebviewWindow};
#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

pub(super) fn prepare_dialog_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let window = app.get_webview_window("main")
        .ok_or("Codex Panel 管理窗口不可用")?;
    #[cfg(target_os = "macos")]
    {
        let window = window.clone();
        run_on_main(move |mtm| {
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            // Tauri 持有窗口；仅在主线程借用 AppKit 对象。
            let window = unsafe { &*pointer.cast::<NSWindow>() };
            restore_dialog_host(window, mtm);
            Ok::<_, String>(())
        })?;
    }
    Ok(window)
}

#[cfg(target_os = "macos")]
fn restore_dialog_host(window: &NSWindow, mtm: MainThreadMarker) {
    // macOS 27 无普通主窗口时，独立 Alert 的玻璃层可能吞掉点击；仅 activate 不足以恢复。
    window.deminiaturize(None);
    window.makeKeyAndOrderFront(None);
    window.makeMainWindow();
    NSApplication::sharedApplication(mtm).activate();
}

#[cfg(target_os = "macos")]
struct UpdateDialogTargetIvars {
    response: RefCell<Option<std::sync::mpsc::Sender<bool>>>,
}

#[cfg(target_os = "macos")]
define_class!(
    #[unsafe(super = NSObject)]
    #[name = "CodexPanelUpdateDialogTarget"]
    #[thread_kind = MainThreadOnly]
    #[ivars = UpdateDialogTargetIvars]
    struct UpdateDialogTarget;

    unsafe impl NSObjectProtocol for UpdateDialogTarget {}

    impl UpdateDialogTarget {
        #[unsafe(method(acceptUpdate:))]
        fn accept_update(&self, _sender: &AnyObject) {
            self.respond(true);
        }

        #[unsafe(method(deferUpdate:))]
        fn defer_update(&self, _sender: &AnyObject) {
            self.respond(false);
        }
    }
);

#[cfg(target_os = "macos")]
impl UpdateDialogTarget {
    fn new(mtm: MainThreadMarker, response: std::sync::mpsc::Sender<bool>) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(UpdateDialogTargetIvars {
            response: RefCell::new(Some(response)),
        });
        unsafe { msg_send![super(this), init] }
    }

    fn respond(&self, accepted: bool) {
        if let Some(response) = self.ivars().response.borrow_mut().take() {
            let _ = response.send(accepted);
        }
    }
}

#[cfg(target_os = "macos")]
struct NativeUpdateDialog {
    alert: Retained<NSAlert>,
    host: Retained<NSWindow>,
    progress_indicator: Retained<NSProgressIndicator>,
    install_button: Retained<NSButton>,
    defer_button: Retained<NSButton>,
    _target: Retained<UpdateDialogTarget>,
}

#[cfg(target_os = "macos")]
#[derive(Clone)]
pub(super) struct UpdateDialog {
    native: Arc<MainThreadBound<NativeUpdateDialog>>,
}

#[cfg(target_os = "macos")]
impl UpdateDialog {
    pub(super) fn prompt(app: &AppHandle, version: &str) -> Option<Self> {
        let message = format!("{version} 已下载并通过签名验证。是否安装并重启 Codex Panel？");
        Self::prompt_message(app, "Codex Panel 更新", message, "安装并重启")
    }

    fn prompt_message(
        app: &AppHandle,
        title: &'static str,
        message: String,
        confirm: &'static str,
    ) -> Option<Self> {
        let host = match prepare_dialog_window(app) {
            Ok(host) => host,
            Err(error) => {
                eprintln!("Unable to prepare native confirmation: {error}");
                return None;
            }
        };
        let (response, result) = std::sync::mpsc::channel();
        let dialog = run_on_main(move |mtm| {
            let pointer = host.ns_window().ok()?;
            // Sheet 显示和安装期间持有其父窗口。
            let host = unsafe { Retained::retain(pointer.cast::<NSWindow>()) }?;
            let alert = NSAlert::new(mtm);
            let target = UpdateDialogTarget::new(mtm, response);
            let progress_indicator = NSProgressIndicator::new(mtm);
            progress_indicator.setStyle(NSProgressIndicatorStyle::Bar);
            progress_indicator.setMinValue(0.0);
            progress_indicator.setMaxValue(100.0);
            progress_indicator.setFrameSize(NSSize::new(280.0, 20.0));
            progress_indicator.sizeToFit();
            progress_indicator.setDisplayedWhenStopped(true);
            alert.setMessageText(&NSString::from_str(title));
            alert.setInformativeText(&NSString::from_str(&message));
            let install_button = alert.addButtonWithTitle(&NSString::from_str(confirm));
            let defer_button = alert.addButtonWithTitle(&NSString::from_str("稍后"));
            // 交由 AppKit 建立原生 Sheet 生命周期，不能只把 Alert 窗口置前。
            alert.beginSheetModalForWindow_completionHandler(&host, None);
            unsafe {
                install_button.setTarget(Some(&target));
                install_button.setAction(Some(sel!(acceptUpdate:)));
                defer_button.setTarget(Some(&target));
                defer_button.setAction(Some(sel!(deferUpdate:)));
            }
            Some(Self {
                native: Arc::new(MainThreadBound::new(
                    NativeUpdateDialog {
                        alert,
                        host,
                        progress_indicator,
                        install_button,
                        defer_button,
                        _target: target,
                    },
                    mtm,
                )),
            })
        })?;
        if result.recv().unwrap_or(false) {
            Some(dialog)
        } else {
            dialog.close();
            None
        }
    }

    pub(super) fn show_installing(&self, message: &str) {
        let native = Arc::clone(&self.native);
        let message = message.to_owned();
        run_on_main(move |mtm| {
            let native = native.get(mtm);
            native
                .alert
                .setInformativeText(&NSString::from_str(&message));
            native.progress_indicator.setIndeterminate(false);
            native.progress_indicator.setDoubleValue(100.0);
            native
                .alert
                .setAccessoryView(Some(&native.progress_indicator));
            native.install_button.setHidden(true);
            native.defer_button.setEnabled(false);
            native.defer_button.setHidden(true);
            native.alert.layout();
            native.progress_indicator.setNeedsDisplay(true);
            native.progress_indicator.displayIfNeeded();
        });
    }

    pub(super) fn close(&self) {
        let native = Arc::clone(&self.native);
        run_on_main(move |mtm| {
            let native = native.get(mtm);
            native.host.endSheet(&native.alert.window());
            native.alert.window().close();
        });
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) struct UpdateDialog;

#[cfg(not(target_os = "macos"))]
impl UpdateDialog {
    pub(super) fn prompt(app: &AppHandle, version: &str) -> Option<Self> {
        Self::prompt_message(
            app,
            "Codex Panel 更新",
            format!("{version} 已下载并通过签名验证。是否安装并重启 Codex Panel？"),
            "安装并重启",
        )
    }

    fn prompt_message(
        app: &AppHandle,
        title: &'static str,
        message: String,
        confirm: &'static str,
    ) -> Option<Self> {
        app.dialog()
            .message(message)
            .title(title)
            .buttons(MessageDialogButtons::OkCancelCustom(
                confirm.into(),
                "稍后".into(),
            ))
            .blocking_show()
            .then_some(Self)
    }

    pub(super) fn show_installing(&self, _message: &str) {}

    pub(super) fn close(&self) {}
}

impl UpdateDialog {
    pub(super) fn confirm_codex_restart(app: &AppHandle) -> bool {
        // 复用可置前的原生确认框，避免后台启动器的 Tauri 弹窗不可见而卡住恢复。
        let Some(dialog) = Self::prompt_message(app, "需要重启 Codex",
            "将退出并重新启动 Codex，正在运行的任务会中断。请先保存工作。".into(),
            "重启 Codex 并连接") else {
            return false;
        };
        dialog.close();
        true
    }
}
