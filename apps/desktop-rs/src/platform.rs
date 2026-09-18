use iced::window;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaterialStatus {
    #[cfg_attr(not(target_os = "windows"), allow(dead_code))]
    Native,
    Fallback,
}

pub fn install_material(id: window::Id, dark: bool) -> iced::Task<MaterialStatus> {
    window::run(id, move |window| {
        #[cfg(target_os = "macos")]
        {
            let _ = (window, dark);
            MaterialStatus::Fallback
        }
        #[cfg(target_os = "windows")]
        {
            if window_vibrancy::apply_mica(window, Some(dark)).is_ok() {
                MaterialStatus::Native
            } else {
                MaterialStatus::Fallback
            }
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            let _ = (window, dark);
            MaterialStatus::Fallback
        }
    })
}
