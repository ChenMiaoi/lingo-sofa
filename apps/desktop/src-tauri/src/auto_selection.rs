//! Opt-in mouse gestures trigger isolated UIA reads, never desktop text polling.
use lingo_sofa_core::overlay::Rect;
use std::sync::{
    Arc, Condvar, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::Duration;

#[derive(Clone)]
struct Fingerprint {
    source: usize,
    text: String,
    bounds: Rect,
}
#[derive(Default)]
struct State {
    enabled: bool,
    stopped: bool,
    inflight: bool,
    source: Option<usize>,
    token: Arc<AtomicBool>,
    last: Option<Fingerprint>,
}
#[derive(Clone, Default)]
pub struct Controller {
    state: Arc<(Mutex<State>, Condvar)>,
    thread: Arc<Mutex<Option<std::thread::JoinHandle<()>>>>,
    pump: Arc<Mutex<Option<Arc<mouse_events::PumpControl>>>>,
    event_generation: Arc<std::sync::atomic::AtomicU64>,
}
pub struct Permit {
    controller: Controller,
    pub token: Arc<AtomicBool>,
}
impl Permit {
    pub fn valid(&self) -> bool {
        self.token.load(Ordering::SeqCst)
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        let (state, wake) = &*self.controller.state;
        let mut state = state.lock().unwrap();
        state.inflight = false;
        state.source = None;
        drop(state);
        wake.notify_all();
    }
}
impl Controller {
    pub fn set_enabled(&self, enabled: bool) {
        let (state, wake) = &*self.state;
        let mut state = state.lock().unwrap();
        if state.enabled != enabled {
            self.event_generation.fetch_add(1, Ordering::SeqCst);
            state.token.store(false, Ordering::SeqCst);
            state.token = Arc::new(AtomicBool::new(enabled));
            state.enabled = enabled;
            wake.notify_all();
        }
        drop(state);
        self.sync_pump();
    }
    fn sync_pump(&self) {
        let pump = self.pump.lock().unwrap();
        if let Some(pump) = pump.as_ref() {
            let state = self.state.0.lock().unwrap();
            pump.request(state.enabled, state.stopped);
        }
    }
    pub fn interrupt(&self) {
        self.event_generation.fetch_add(1, Ordering::SeqCst);
        self.interrupt_probe();
    }
    fn interrupt_probe(&self) {
        let state = self.state.0.lock().unwrap();
        state.token.store(false, Ordering::SeqCst);
    }
    pub fn check_source(&self, source: Option<usize>) {
        let state = self.state.0.lock().unwrap();
        if state.inflight && state.source != source {
            state.token.store(false, Ordering::SeqCst);
        }
    }
    pub fn begin(&self, source: usize, generation: u64) -> Option<Permit> {
        let mut state = self.state.0.lock().unwrap();
        if !state.enabled
            || state.stopped
            || state.inflight
            || generation != self.event_generation.load(Ordering::SeqCst)
        {
            return None;
        }
        state.inflight = true;
        state.source = Some(source);
        state.token = Arc::new(AtomicBool::new(true));
        Some(Permit {
            controller: self.clone(),
            token: state.token.clone(),
        })
    }
    pub fn duplicate(&self, source: usize, text: &str, bounds: Rect) -> bool {
        self.state
            .0
            .lock()
            .unwrap()
            .last
            .as_ref()
            .is_some_and(|last| {
                last.source == source && last.text == text && last.bounds.near(bounds)
            })
    }
    pub fn remember(&self, source: usize, text: String, bounds: Rect) {
        self.state.0.lock().unwrap().last = Some(Fingerprint {
            source,
            text,
            bounds,
        });
    }
    pub fn shutdown(&self) {
        let (state, wake) = &*self.state;
        {
            let mut state = state.lock().unwrap();
            state.stopped = true;
            state.enabled = false;
            self.event_generation.fetch_add(1, Ordering::SeqCst);
            state.token.store(false, Ordering::SeqCst);
            wake.notify_all();
        }
        self.sync_pump();
        if let Some(thread) = self.thread.lock().unwrap().take() {
            let _ = thread.join();
        }
        // The helper and its reader are reaped by watch() before Permit drops.
        let state = state.lock().unwrap();
        let _ = wake.wait_timeout_while(state, Duration::from_secs(5), |s| s.inflight);
    }
}

#[derive(Default)]
struct Gesture {
    generation: Option<u64>,
    pressed: bool,
    press_source: Option<usize>,
    pending: Option<(usize, u64)>,
}
impl Gesture {
    fn enter_generation(&mut self, generation: u64) {
        if self.generation != Some(generation) {
            *self = Self {
                generation: Some(generation),
                ..Default::default()
            };
        }
    }
    fn observe(&mut self, down: bool, source: Option<usize>, now_ms: u64) -> Option<usize> {
        if down {
            if !self.pressed {
                self.press_source = source;
            }
            self.pending = None;
        } else if self.pressed {
            self.pending = source
                .filter(|source| Some(*source) == self.press_source)
                .map(|source| (source, now_ms));
            self.press_source = None;
        }
        self.pressed = down;
        if let Some((host, released)) = self.pending {
            if source != Some(host) {
                self.pending = None;
            } else if now_ms.saturating_sub(released) >= 350 {
                self.pending = None;
                return Some(host);
            }
        }
        None
    }
}

#[cfg(windows)]
pub fn foreground_source() -> Option<usize> {
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let window = unsafe { GetForegroundWindow() };
    let mut process = 0;
    unsafe {
        GetWindowThreadProcessId(window, Some(&mut process));
    }
    (!window.0.is_null() && process != 0 && process != std::process::id())
        .then_some(window.0 as usize)
}
#[cfg(windows)]
pub fn mouse_down() -> bool {
    use windows::Win32::UI::{
        Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON, VK_RBUTTON},
        WindowsAndMessaging::{GetSystemMetrics, SM_SWAPBUTTON},
    };
    let button = if unsafe { GetSystemMetrics(SM_SWAPBUTTON) } == 0 {
        VK_LBUTTON
    } else {
        VK_RBUTTON
    };
    unsafe { GetAsyncKeyState(i32::from(button.0)) < 0 }
}
#[cfg(windows)]
mod mouse_events {
    use super::*;
    use std::{
        cell::RefCell,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        sync::{atomic::AtomicU8, mpsc},
        time::Instant,
    };
    use windows::Win32::{
        Foundation::{HANDLE, HINSTANCE, LPARAM, LRESULT, POINT, WAIT_FAILED, WPARAM},
        System::{
            LibraryLoader::GetModuleHandleW,
            Threading::{CreateEventW, INFINITE, SetEvent},
        },
        UI::WindowsAndMessaging::*,
    };
    const DISABLED: u8 = 0;
    const ENABLED: u8 = 1;
    const STOPPED: u8 = 2;
    pub(super) struct PumpControl {
        event: OwnedHandle,
        mode: AtomicU8,
        failed: AtomicBool,
    }
    impl PumpControl {
        fn new() -> windows::core::Result<Self> {
            let event = unsafe { CreateEventW(None, false, false, None) }?;
            Ok(Self {
                event: unsafe { OwnedHandle::from_raw_handle(event.0) },
                mode: AtomicU8::new(DISABLED),
                failed: AtomicBool::new(false),
            })
        }
        fn handle(&self) -> HANDLE {
            HANDLE(self.event.as_raw_handle())
        }
        pub(super) fn request(&self, enabled: bool, stopped: bool) {
            // STOPPED is terminal even if an older settings notification races shutdown.
            let mode = if stopped {
                STOPPED
            } else if enabled {
                ENABLED
            } else {
                DISABLED
            };
            let _ = self
                .mode
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |current| {
                    (current != STOPPED).then_some(mode)
                });
            unsafe {
                let _ = SetEvent(self.handle());
            }
        }
        fn wait(&self) -> windows::core::Result<()> {
            let handles = [self.handle()];
            let result = unsafe {
                MsgWaitForMultipleObjectsEx(
                    Some(&handles),
                    INFINITE,
                    QS_ALLINPUT,
                    MWMO_INPUTAVAILABLE,
                )
            };
            if result == WAIT_FAILED {
                Err(windows::core::Error::from_thread())
            } else {
                Ok(())
            }
        }
    }
    struct Event {
        generation: u64,
        foreground: usize,
        message: u32,
        point: POINT,
        time_ms: u64,
    }
    #[derive(Clone)]
    struct Sink {
        sender: mpsc::SyncSender<Event>,
        overflow: Arc<AtomicBool>,
        clock: Instant,
        generation: Arc<std::sync::atomic::AtomicU64>,
    }
    thread_local! { static SINK: RefCell<Option<Sink>> = const { RefCell::new(None) }; }
    fn enqueue(sink: &Sink, event: Event) {
        if sink.sender.try_send(event).is_err() {
            sink.overflow.store(true, Ordering::SeqCst);
        }
    }
    unsafe extern "system" fn on_mouse(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
        if code >= 0
            && matches!(
                message.0 as u32,
                WM_LBUTTONDOWN | WM_LBUTTONUP | WM_RBUTTONDOWN | WM_RBUTTONUP
            )
        {
            let mouse = unsafe { &*(data.0 as *const MSLLHOOKSTRUCT) };
            // Stamp only the foreground handle; no target queries, application locks or business work.
            if mouse.flags & LLMHF_INJECTED == 0 {
                SINK.with(|sink| {
                    if let Some(sink) = sink.borrow().as_ref() {
                        enqueue(
                            sink,
                            Event {
                                generation: sink.generation.load(Ordering::SeqCst),
                                foreground: unsafe { GetForegroundWindow() }.0 as usize,
                                message: message.0 as u32,
                                point: mouse.pt,
                                time_ms: sink.clock.elapsed().as_millis() as u64,
                            },
                        );
                    }
                });
            }
        }
        unsafe { CallNextHookEx(None, code, message, data) }
    }
    struct Hook(HHOOK);
    impl Drop for Hook {
        fn drop(&mut self) {
            unsafe {
                let _ = UnhookWindowsHookEx(self.0);
            }
            SINK.with(|sink| *sink.borrow_mut() = None);
        }
    }
    fn install() -> windows::core::Result<Hook> {
        let module = unsafe { GetModuleHandleW(None) }?;
        unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(on_mouse), Some(HINSTANCE(module.0)), 0) }
            .map(Hook)
    }
    // The hook-owning thread waits on Windows messages and a control event only.
    // Its lifecycle callback may install/uninstall a hook; application work lives elsewhere.
    fn message_pump(
        control: &PumpControl,
        mut lifecycle: impl FnMut(bool) -> windows::core::Result<()>,
        mut observed: impl FnMut(&MSG),
    ) -> windows::core::Result<()> {
        loop {
            let mode = control.mode.load(Ordering::SeqCst);
            if mode == STOPPED {
                return Ok(());
            }
            lifecycle(mode == ENABLED)?;
            let mut message = MSG::default();
            // A bounded batch lets control changes win even under continuous input.
            for _ in 0..64 {
                if !unsafe { PeekMessageW(&mut message, None, 0, 0, PM_REMOVE) }.as_bool() {
                    break;
                }
                if message.message == WM_QUIT {
                    return Ok(());
                }
                observed(&message);
                unsafe {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
                if control.mode.load(Ordering::SeqCst) != mode {
                    break;
                }
            }
            // SetEvent and sent/posted messages wake this immediately; no timed sleep.
            control.wait()?;
        }
    }
    fn hook_pump<H>(
        control: &PumpControl,
        sink: Sink,
        mut install_hook: impl FnMut() -> windows::core::Result<H>,
    ) {
        let mut hook = None;
        let result = message_pump(
            control,
            |enabled| {
                if enabled && hook.is_none() {
                    SINK.with(|current| *current.borrow_mut() = Some(sink.clone()));
                    match install_hook() {
                        Ok(installed) => hook = Some(installed),
                        Err(_) => {
                            SINK.with(|current| *current.borrow_mut() = None);
                            control.request(false, false);
                            control.failed.store(true, Ordering::SeqCst);
                        }
                    }
                } else if !enabled {
                    hook.take();
                    SINK.with(|current| *current.borrow_mut() = None);
                }
                Ok(())
            },
            |_| {},
        );
        drop(hook);
        SINK.with(|current| *current.borrow_mut() = None);
        if result.is_err() {
            control.failed.store(true, Ordering::SeqCst);
        }
    }
    fn source_at(point: POINT) -> Option<usize> {
        let target = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
        let mut process = 0;
        unsafe {
            GetWindowThreadProcessId(target, Some(&mut process));
        }
        (!target.0.is_null() && process != 0 && process != std::process::id())
            .then_some(target.0 as usize)
    }
    fn process_event(this: &Controller, gesture: &mut Gesture, event: Event) {
        let generation = this.event_generation.load(Ordering::SeqCst);
        gesture.enter_generation(generation);
        if event.generation != generation {
            *gesture = Gesture {
                generation: Some(generation),
                ..Default::default()
            };
            return;
        }
        let foreground = foreground_source();
        if Some(event.foreground) != foreground || source_at(event.point) != foreground {
            *gesture = Gesture::default();
            this.interrupt_probe();
            return;
        }
        let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
        let (down, up) = if swapped {
            (WM_RBUTTONDOWN, WM_RBUTTONUP)
        } else {
            (WM_LBUTTONDOWN, WM_LBUTTONUP)
        };
        if event.message != down && event.message != up {
            return;
        }
        let pressed = event.message == down;
        if pressed && foreground.is_some() {
            this.interrupt_probe();
        }
        gesture.observe(pressed, foreground, event.time_ms);
    }
    impl Controller {
        pub fn start(
            &self,
            shell: crate::shell::Shell,
            app: tauri::AppHandle,
            service: lingo_sofa_app_services::Service,
        ) {
            let mut thread = self.thread.lock().unwrap();
            if thread.is_some() {
                return;
            }
            let control = match PumpControl::new() {
                Ok(control) => Arc::new(control),
                Err(_) => {
                    self.set_enabled(false);
                    shell.automatic_failure();
                    return;
                }
            };
            *self.pump.lock().unwrap() = Some(control.clone());
            self.sync_pump();
            let this = self.clone();
            *thread = Some(std::thread::spawn(move || {
                let clock = Instant::now();
                let (tx, rx) = mpsc::sync_channel(16);
                let overflow = Arc::new(AtomicBool::new(false));
                let pump_control = control.clone();
                let pump_overflow = overflow.clone();
                let event_generation = this.event_generation.clone();
                let pump = std::thread::spawn(move || {
                    hook_pump(
                        &pump_control,
                        Sink {
                            sender: tx,
                            overflow: pump_overflow,
                            clock,
                            generation: event_generation,
                        },
                        install,
                    );
                });
                let mut gesture = Gesture::default();
                loop {
                    if control.failed.swap(false, Ordering::SeqCst) {
                        this.set_enabled(false);
                        shell.automatic_failure();
                    }
                    let (state, wake) = &*this.state;
                    let mut state = state.lock().unwrap();
                    while !state.enabled && !state.stopped {
                        gesture = Gesture::default();
                        state = wake.wait(state).unwrap();
                    }
                    if state.stopped {
                        break;
                    }
                    drop(state);
                    if overflow.swap(false, Ordering::SeqCst) {
                        while rx.try_recv().is_ok() {}
                        gesture = Gesture::default();
                        this.interrupt();
                    }
                    match rx.recv_timeout(Duration::from_millis(50)) {
                        Ok(event) => {
                            process_event(&this, &mut gesture, event);
                            while let Ok(event) = rx.try_recv() {
                                process_event(&this, &mut gesture, event);
                            }
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            this.set_enabled(false);
                            shell.automatic_failure();
                            continue;
                        }
                    }
                    let generation = this.event_generation.load(Ordering::SeqCst);
                    gesture.enter_generation(generation);
                    let source = foreground_source();
                    this.check_source(source);
                    if let Some(host) =
                        gesture.observe(gesture.pressed, source, clock.elapsed().as_millis() as u64)
                    {
                        if let Some(permit) = this.begin(host, generation) {
                            shell.capture_automatic(app.clone(), service.clone(), host, permit);
                        } else {
                            gesture.pending =
                                Some((host, clock.elapsed().as_millis() as u64 - 350));
                        }
                    }
                }
                control.request(false, true);
                let _ = pump.join();
            }));
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use windows::Win32::System::Threading::GetCurrentThreadId;
        const PROBE: u32 = WM_APP + 23;
        #[test]
        fn off_on_during_debounce_discards_consumed_release_without_new_events() {
            let controller = Controller::default();
            controller.set_enabled(true);
            let old = controller.event_generation.load(Ordering::SeqCst);
            let mut gesture = Gesture::default();
            gesture.enter_generation(old);
            gesture.observe(true, Some(1), 0);
            gesture.observe(false, Some(1), 20);
            assert!(gesture.pending.is_some());
            controller.set_enabled(false);
            controller.set_enabled(true);
            let new = controller.event_generation.load(Ordering::SeqCst);
            gesture.enter_generation(new);
            assert_eq!(gesture.observe(false, Some(1), 1000), None);
            assert!(controller.begin(1, old).is_none());
        }
        #[test]
        fn hook_install_failure_can_retry_in_the_same_pump_without_a_real_hook() {
            let control = Arc::new(PumpControl::new().unwrap());
            control.request(true, false);
            let worker_control = control.clone();
            let (sender, _receiver) = mpsc::sync_channel(1);
            let (attempt, attempts) = mpsc::channel();
            let (done, exited) = mpsc::channel();
            let pump = std::thread::spawn(move || {
                let mut count = 0;
                hook_pump(
                    &worker_control,
                    Sink {
                        sender,
                        overflow: Arc::new(AtomicBool::new(false)),
                        clock: Instant::now(),
                        generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                    },
                    || {
                        count += 1;
                        attempt.send(count).unwrap();
                        if count == 1 {
                            Err(windows::core::Error::empty())
                        } else {
                            Ok(())
                        }
                    },
                );
                done.send(()).unwrap();
            });
            assert_eq!(
                attempts.recv_timeout(Duration::from_millis(250)).unwrap(),
                1
            );
            let deadline = Instant::now() + Duration::from_millis(250);
            while !control.failed.load(Ordering::SeqCst) {
                assert!(Instant::now() < deadline);
                std::thread::yield_now();
            }
            control.request(true, false);
            assert_eq!(
                attempts.recv_timeout(Duration::from_millis(250)).unwrap(),
                2
            );
            control.request(false, true);
            exited.recv_timeout(Duration::from_millis(250)).unwrap();
            pump.join().unwrap();
        }
        #[test]
        fn off_on_and_manual_intents_reject_queued_old_generation_events() {
            let controller = Controller::default();
            controller.set_enabled(true);
            let old = controller.event_generation.load(Ordering::SeqCst);
            let mut gesture = Gesture {
                pressed: true,
                press_source: Some(1),
                pending: Some((1, 0)),
                ..Default::default()
            };
            controller.set_enabled(false);
            controller.set_enabled(true);
            assert!(controller.begin(1, old).is_none());
            process_event(
                &controller,
                &mut gesture,
                Event {
                    generation: old,
                    foreground: 1,
                    message: WM_LBUTTONUP,
                    point: POINT::default(),
                    time_ms: 500,
                },
            );
            assert!(!gesture.pressed);
            assert!(gesture.pending.is_none());
            let before_manual = controller.event_generation.load(Ordering::SeqCst);
            controller.interrupt();
            gesture.pending = Some((1, 0));
            process_event(
                &controller,
                &mut gesture,
                Event {
                    generation: before_manual,
                    foreground: 1,
                    message: WM_LBUTTONUP,
                    point: POINT::default(),
                    time_ms: 500,
                },
            );
            assert!(gesture.pending.is_none());
        }
        #[test]
        fn message_wait_wakes_for_posted_messages_and_control_exit_without_a_hook() {
            let control = Arc::new(PumpControl::new().unwrap());
            let worker_control = control.clone();
            let (ready, started) = mpsc::channel();
            let (reply, replies) = mpsc::channel();
            let (done, exited) = mpsc::channel();
            let pump = std::thread::spawn(move || {
                // Create this thread's queue, then run the production wait/dispatch loop.
                let mut message = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                }
                ready.send(unsafe { GetCurrentThreadId() }).unwrap();
                let result = message_pump(
                    &worker_control,
                    |_| Ok(()),
                    |message| {
                        if message.message == PROBE {
                            reply.send(message.wParam.0).unwrap();
                        }
                    },
                );
                done.send(result.is_ok()).unwrap();
            });
            let id = started.recv_timeout(Duration::from_secs(1)).unwrap();
            for index in 0..8 {
                unsafe { PostThreadMessageW(id, PROBE, WPARAM(index), LPARAM(0)) }.unwrap();
                assert_eq!(
                    replies.recv_timeout(Duration::from_millis(250)).unwrap(),
                    index
                );
            }
            control.request(false, true);
            assert!(exited.recv_timeout(Duration::from_millis(250)).unwrap());
            pump.join().unwrap();
        }
        #[test]
        fn sent_window_messages_wake_the_idle_pump_without_installing_a_hook() {
            use windows::{Win32::Foundation::HWND, core::w};
            let control = Arc::new(PumpControl::new().unwrap());
            let worker_control = control.clone();
            let (ready, window_ready) = mpsc::channel();
            let (done, exited) = mpsc::channel();
            let pump = std::thread::spawn(move || {
                // A message-only built-in window is invisible and needs no global hook.
                let window = unsafe {
                    CreateWindowExW(
                        WINDOW_EX_STYLE::default(),
                        w!("STATIC"),
                        w!(""),
                        WINDOW_STYLE::default(),
                        0,
                        0,
                        0,
                        0,
                        Some(HWND_MESSAGE),
                        None,
                        None,
                        None,
                    )
                }
                .unwrap();
                ready.send(window.0 as usize).unwrap();
                let result = message_pump(&worker_control, |_| Ok(()), |_| {});
                unsafe { DestroyWindow(window) }.unwrap();
                done.send(result.is_ok()).unwrap();
            });
            let window = HWND(window_ready.recv_timeout(Duration::from_secs(1)).unwrap() as *mut _);
            for _ in 0..8 {
                let result = unsafe {
                    SendMessageTimeoutW(
                        window,
                        PROBE,
                        WPARAM(0),
                        LPARAM(0),
                        SMTO_ABORTIFHUNG,
                        250,
                        None,
                    )
                };
                assert_ne!(
                    result.0, 0,
                    "sent message must be processed while the pump is idle"
                );
            }
            control.request(false, true);
            assert!(exited.recv_timeout(Duration::from_millis(250)).unwrap());
            pump.join().unwrap();
        }
        #[test]
        fn disabled_and_enabled_control_changes_wake_an_idle_pump_without_input() {
            let control = Arc::new(PumpControl::new().unwrap());
            let worker_control = control.clone();
            let (changes, observed) = mpsc::channel();
            let (done, exited) = mpsc::channel();
            let pump = std::thread::spawn(move || {
                let result = message_pump(
                    &worker_control,
                    |enabled| {
                        changes.send(enabled).unwrap();
                        Ok(())
                    },
                    |_| {},
                );
                done.send(result.is_ok()).unwrap();
            });
            assert!(!observed.recv_timeout(Duration::from_millis(250)).unwrap());
            control.request(true, false);
            assert!(observed.recv_timeout(Duration::from_millis(250)).unwrap());
            control.request(false, false);
            assert!(!observed.recv_timeout(Duration::from_millis(250)).unwrap());
            control.request(false, true);
            assert!(exited.recv_timeout(Duration::from_millis(250)).unwrap());
            pump.join().unwrap();
        }
        #[test]
        fn blocked_business_receiver_and_full_queue_do_not_block_message_pump_or_shutdown() {
            let control = Arc::new(PumpControl::new().unwrap());
            let worker_control = control.clone();
            let (events, _blocked_receiver) = mpsc::sync_channel(1);
            let overflow = Arc::new(AtomicBool::new(false));
            let pump_overflow = overflow.clone();
            let (ready, started) = mpsc::channel();
            let (reply, replies) = mpsc::channel();
            let (done, exited) = mpsc::channel();
            let pump = std::thread::spawn(move || {
                let mut message = MSG::default();
                unsafe {
                    let _ = PeekMessageW(&mut message, None, 0, 0, PM_NOREMOVE);
                }
                let sink = Sink {
                    sender: events,
                    overflow: pump_overflow,
                    clock: Instant::now(),
                    generation: Arc::new(std::sync::atomic::AtomicU64::new(0)),
                };
                ready.send(unsafe { GetCurrentThreadId() }).unwrap();
                let result = message_pump(
                    &worker_control,
                    |_| Ok(()),
                    |message| {
                        if message.message == PROBE {
                            enqueue(
                                &sink,
                                Event {
                                    generation: 0,
                                    foreground: 0,
                                    message: WM_LBUTTONUP,
                                    point: POINT::default(),
                                    time_ms: 0,
                                },
                            );
                            reply.send(()).unwrap();
                        }
                    },
                );
                done.send(result.is_ok()).unwrap();
            });
            let id = started.recv_timeout(Duration::from_secs(1)).unwrap();
            for _ in 0..24 {
                unsafe { PostThreadMessageW(id, PROBE, WPARAM(0), LPARAM(0)) }.unwrap();
                replies.recv_timeout(Duration::from_millis(250)).unwrap();
            }
            assert!(overflow.load(Ordering::SeqCst));
            control.request(false, true);
            assert!(exited.recv_timeout(Duration::from_millis(250)).unwrap());
            pump.join().unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect() -> Rect {
        Rect {
            x: 10.0,
            y: 20.0,
            width: 80.0,
            height: 25.0,
        }
    }
    #[test]
    fn foreground_switch_after_settling_invalidates_pending_admission() {
        let c = Controller::default();
        c.set_enabled(true);
        let permit = c
            .begin(1, c.event_generation.load(Ordering::SeqCst))
            .unwrap();
        c.check_source(Some(1));
        assert!(permit.valid());
        c.check_source(Some(2));
        assert!(!permit.valid());
        drop(permit);
        let next = c
            .begin(2, c.event_generation.load(Ordering::SeqCst))
            .unwrap();
        assert!(next.valid());
        c.check_source(None);
        assert!(!next.valid());
    }
    #[test]
    fn disabled_controller_never_starts_and_disable_fences_late_results() {
        let c = Controller::default();
        assert!(
            c.begin(1, c.event_generation.load(Ordering::SeqCst))
                .is_none()
        );
        c.set_enabled(true);
        let permit = c
            .begin(1, c.event_generation.load(Ordering::SeqCst))
            .unwrap();
        assert!(permit.valid());
        assert!(
            c.begin(1, c.event_generation.load(Ordering::SeqCst))
                .is_none()
        );
        c.set_enabled(false);
        assert!(!permit.valid());
        assert!(
            c.begin(1, c.event_generation.load(Ordering::SeqCst))
                .is_none()
        );
        drop(permit);
        c.set_enabled(true);
        let permit = c
            .begin(1, c.event_generation.load(Ordering::SeqCst))
            .unwrap();
        c.interrupt();
        assert!(!permit.valid());
        drop(permit);
        c.shutdown();
        assert!(
            c.begin(1, c.event_generation.load(Ordering::SeqCst))
                .is_none()
        );
    }
    #[test]
    fn duplicate_suppression_survives_disable_and_manual_interrupt_but_accepts_new_selection() {
        let c = Controller::default();
        c.remember(1, "selected".into(), rect());
        c.set_enabled(true);
        c.interrupt();
        c.set_enabled(false);
        c.set_enabled(true);
        assert!(c.duplicate(1, "selected", rect()));
        assert!(!c.duplicate(2, "selected", rect()));
        assert!(!c.duplicate(1, "changed", rect()));
        assert!(!c.duplicate(1, "selected", Rect { x: 200.0, ..rect() }));
    }
    #[test]
    fn release_waits_for_settled_source_and_does_not_repeat_on_unchanged_idle() {
        let mut g = Gesture::default();
        assert_eq!(g.observe(false, Some(1), 0), None);
        assert_eq!(g.observe(true, Some(1), 10), None);
        assert_eq!(g.observe(false, Some(1), 100), None);
        assert_eq!(g.observe(false, Some(1), 449), None);
        assert_eq!(g.observe(false, Some(1), 450), Some(1));
        assert_eq!(g.observe(false, Some(1), 1000), None);
        // A double-click selects a word after its second release too.
        g.observe(true, Some(1), 1100);
        g.observe(false, Some(1), 1150);
        g.observe(true, Some(1), 1200);
        g.observe(false, Some(1), 1250);
        assert_eq!(g.observe(false, Some(1), 1600), Some(1));
    }
    #[test]
    fn own_windows_and_source_switches_never_produce_a_candidate() {
        let mut g = Gesture::default();
        g.observe(true, None, 0);
        g.observe(false, None, 100);
        assert_eq!(g.observe(false, None, 500), None);
        g.observe(true, None, 600);
        g.observe(false, Some(1), 650);
        assert_eq!(g.observe(false, Some(1), 1000), None);
        g.observe(true, Some(2), 1100);
        g.observe(false, Some(1), 1150);
        assert_eq!(g.observe(false, Some(1), 1600), None);
        g.observe(true, Some(1), 1700);
        g.observe(false, Some(1), 1750);
        assert_eq!(g.observe(false, Some(2), 2100), None);
        assert_eq!(g.observe(false, Some(1), 2500), None);
    }
}
