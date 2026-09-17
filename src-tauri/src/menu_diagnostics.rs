use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Instant, SystemTime, UNIX_EPOCH},
};

pub fn log(path: &Path, event: &str) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "[menu-diagnostic] ts_ms={timestamp} pid={} {event}",
            std::process::id()
        );
    }
}

static NEXT_SPAN: AtomicU64 = AtomicU64::new(1);

pub struct Span {
    path: PathBuf,
    event: String,
    started: Instant,
    id: u64,
}

impl Span {
    pub fn new(path: &Path, event: impl Into<String>) -> Self {
        let event = event.into();
        let id = NEXT_SPAN.fetch_add(1, Ordering::Relaxed);
        log(path, &format!("{event} begin span={id}"));
        Self {
            path: path.into(),
            event,
            started: Instant::now(),
            id,
        }
    }
}

impl Drop for Span {
    fn drop(&mut self) {
        log(
            &self.path,
            &format!(
                "{} end span={} elapsed_ms={}",
                self.event,
                self.id,
                self.started.elapsed().as_millis()
            ),
        );
    }
}

#[cfg(target_os = "macos")]
mod native {
    use super::*;
    use objc2::rc::Retained;
    use objc2::{define_class, msg_send, sel, DefinedClass, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{
        NSMenuDidBeginTrackingNotification, NSMenuDidEndTrackingNotification,
        NSMenuDidSendActionNotification, NSMenuWillSendActionNotification,
    };
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObject, NSObjectProtocol};
    use std::{
        cell::RefCell,
        sync::atomic::{AtomicUsize, Ordering},
    };

    static TRACKING: AtomicUsize = AtomicUsize::new(0);
    thread_local! { static OBSERVER: RefCell<Option<Retained<MenuObserver>>> = const { RefCell::new(None) }; }

    define_class!(
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = PathBuf]
        struct MenuObserver;
        unsafe impl NSObjectProtocol for MenuObserver {}
        impl MenuObserver {
            #[unsafe(method(menuNotification:))]
            fn notification(&self, notification: &NSNotification) {
                let name = notification.name().to_string();
                if name == "NSMenuDidBeginTrackingNotification" { TRACKING.fetch_add(1, Ordering::Relaxed); }
                if name == "NSMenuDidEndTrackingNotification" {
                    let _ = TRACKING.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |n| Some(n.saturating_sub(1)));
                }
                // Observe this process's menus without replacing AppKit's delegate or event handling.
                let object = notification.object();
                log(self.ivars(), &format!("native event={name} menu={:p}", object.as_deref().map_or(std::ptr::null(), |value| value as *const _)));
            }
        }
    );

    pub fn install(path: &Path) {
        let Some(marker) = MainThreadMarker::new() else {
            return;
        };
        let observer: Retained<MenuObserver> = unsafe {
            msg_send![
                super(MenuObserver::alloc(marker).set_ivars(path.into())),
                init
            ]
        };
        let center = NSNotificationCenter::defaultCenter();
        // SAFETY: the selector accepts NSNotification; the observer stays alive on the main thread.
        unsafe {
            for name in [
                NSMenuDidBeginTrackingNotification,
                NSMenuDidEndTrackingNotification,
                NSMenuWillSendActionNotification,
                NSMenuDidSendActionNotification,
            ] {
                center.addObserver_selector_name_object(
                    &observer,
                    sel!(menuNotification:),
                    Some(name),
                    None,
                );
            }
        }
        OBSERVER.with(|slot| *slot.borrow_mut() = Some(observer));
        log(path, "native observer installed scope=process_menus");
    }

    pub fn tracking() -> bool {
        TRACKING.load(Ordering::Relaxed) > 0
    }
}

#[cfg(target_os = "macos")]
pub use native::{install, tracking};
#[cfg(not(target_os = "macos"))]
pub fn tracking() -> bool {
    false
}
