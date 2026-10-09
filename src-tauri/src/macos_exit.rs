use objc2::{
    ffi::class_addMethod,
    runtime::{AnyClass, AnyObject, Imp, Sel},
    sel, MainThreadMarker,
};
use objc2_app_kit::NSApplication;
use std::sync::OnceLock;

static REQUEST_EXIT: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

unsafe extern "C-unwind" fn should_terminate(
    _delegate: *mut AnyObject,
    _selector: Sel,
    _application: *mut AnyObject,
) -> usize {
    if let Some(request) = REQUEST_EXIT.get() {
        request();
    }
    // NSTerminateCancel：先保留 AppKit 事件循环，让 Tauri 的后台清理完成后退出。
    0
}

fn install_on_class(class: &AnyClass, request: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    let selector = sel!(applicationShouldTerminate:);
    // 当前 Tao 没有此方法；不覆盖未来版本自己的退出决策。
    if class.instance_method(selector).is_some() {
        return Err("原生退出代理已存在，无法安全安装 Panel 退出处理。".into());
    }
    REQUEST_EXIT.set(Box::new(request)).map_err(|_| "退出处理已安装。".to_string())?;
    // macOS 的两种目标架构均为 64 位；返回 NSUInteger，参数为 self、SEL、NSApplication。
    let added = unsafe {
        let implementation = std::mem::transmute::<
            unsafe extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize,
            Imp,
        >(should_terminate);
        class_addMethod(class as *const _ as *mut _, selector, implementation, c"Q@:@".as_ptr())
    };
    if !added.as_bool() {
        return Err("安装 Panel 原生退出处理失败。".into());
    }
    Ok(())
}

pub fn install(request: impl Fn() + Send + Sync + 'static) -> Result<(), String> {
    let marker = MainThreadMarker::new().ok_or("退出处理必须在主线程安装。")?;
    let application = NSApplication::sharedApplication(marker);
    let delegate = application.delegate().ok_or("缺少原生应用代理。")?;
    let object: &AnyObject = (*delegate).as_ref();
    install_on_class(object.class(), request)?;
    // AppKit 缓存代理支持的方法；保留同一个 Tao 代理，只刷新其方法查询结果。
    application.setDelegate(None);
    application.setDelegate(Some(&delegate));
    Ok(())
}

#[cfg(test)]
mod tests {
    #[test]
    fn native_quit_is_cancelled_and_forwarded_to_managed_exit() {
        use objc2::{msg_send, rc::Retained, runtime::{AnyObject, ClassBuilder}, ClassType};
        use objc2_foundation::NSObject;
        use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
        let class = ClassBuilder::new(c"PanelExitTestDelegate", NSObject::class()).unwrap().register();
        let calls = Arc::new(AtomicUsize::new(0));
        let received = Arc::clone(&calls);
        super::install_on_class(class, move || { received.fetch_add(1, Ordering::SeqCst); }).unwrap();
        let delegate: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let reply: usize = unsafe {
            msg_send![&*delegate, applicationShouldTerminate: std::ptr::null::<AnyObject>()]
        };
        assert_eq!(reply, 0, "原生退出必须暂缓，不能直接销毁事件循环");
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
