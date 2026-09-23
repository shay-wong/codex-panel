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
    NSAlert, NSApplication, NSButton, NSProgressIndicator, NSProgressIndicatorStyle,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSObject, NSSize, NSString};
#[cfg(target_os = "macos")]
use std::{cell::RefCell, sync::Arc};
use tauri::AppHandle;
#[cfg(not(target_os = "macos"))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

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
    pub(super) fn prompt(_app: &AppHandle, version: &str) -> Option<Self> {
        let message = format!("{version} 已下载并通过签名验证。是否安装并重启 Codex Panel？");
        let (response, result) = std::sync::mpsc::channel();
        let dialog = run_on_main(move |mtm| {
            let alert = NSAlert::new(mtm);
            let target = UpdateDialogTarget::new(mtm, response);
            let progress_indicator = NSProgressIndicator::new(mtm);
            progress_indicator.setStyle(NSProgressIndicatorStyle::Bar);
            progress_indicator.setMinValue(0.0);
            progress_indicator.setMaxValue(100.0);
            progress_indicator.setFrameSize(NSSize::new(280.0, 20.0));
            progress_indicator.sizeToFit();
            progress_indicator.setDisplayedWhenStopped(true);
            alert.setMessageText(&NSString::from_str("Codex Panel 更新"));
            alert.setInformativeText(&NSString::from_str(&message));
            let install_button = alert.addButtonWithTitle(&NSString::from_str("安装并重启"));
            let defer_button = alert.addButtonWithTitle(&NSString::from_str("稍后"));
            unsafe {
                install_button.setTarget(Some(&target));
                install_button.setAction(Some(sel!(acceptUpdate:)));
                defer_button.setTarget(Some(&target));
                defer_button.setAction(Some(sel!(deferUpdate:)));
            }
            alert.layout();
            let window = alert.window();
            window.center();
            NSApplication::sharedApplication(mtm).activate();
            window.makeKeyAndOrderFront(None);
            window.orderFrontRegardless();
            Self {
                native: Arc::new(MainThreadBound::new(
                    NativeUpdateDialog {
                        alert,
                        progress_indicator,
                        install_button,
                        defer_button,
                        _target: target,
                    },
                    mtm,
                )),
            }
        });
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
            native.alert.window().close();
        });
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) struct UpdateDialog;

#[cfg(not(target_os = "macos"))]
impl UpdateDialog {
    pub(super) fn prompt(app: &AppHandle, version: &str) -> Option<Self> {
        app.dialog()
            .message(format!(
                "{version} 已下载并通过签名验证。是否安装并重启 Codex Panel？"
            ))
            .title("Codex Panel 更新")
            .buttons(MessageDialogButtons::OkCancelCustom(
                "安装并重启".into(),
                "稍后".into(),
            ))
            .blocking_show()
            .then_some(Self)
    }

    pub(super) fn show_installing(&self, _message: &str) {}

    pub(super) fn close(&self) {}
}
