use iced::widget::{button, container};
use iced::{Background, Border, Color, Shadow, Theme, border, theme};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Light,
    Dark,
}

pub const SIDEBAR_WIDTH: f32 = 240.0;
pub const NAVIGATION_HEIGHT: f32 = 28.0;
pub const TEXT_CAPTION: f32 = 12.0;
pub const TEXT_SMALL: f32 = 13.0;
pub const TEXT_BODY: f32 = 14.0;
pub const TEXT_LEAD: f32 = 15.0;
pub const TEXT_CHAT: f32 = 16.0;
pub const RADIUS_CONTROL: f32 = 4.0;
pub const RADIUS_PANEL: f32 = 6.0;

#[derive(Debug, Clone, Copy)]
pub struct Tokens {
    pub background: Color,
    pub sidebar: Color,
    pub surface: Color,
    pub surface_hover: Color,
    pub border: Color,
    pub text: Color,
    pub muted: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
}

impl Mode {
    pub fn tokens(self) -> Tokens {
        match self {
            Self::Light => Tokens {
                background: Color::from_rgb8(255, 255, 255),
                sidebar: Color::from_rgba8(250, 250, 250, 0.82),
                surface: Color::from_rgb8(250, 250, 250),
                surface_hover: Color::from_rgb8(233, 237, 249),
                border: Color::from_rgb8(224, 225, 229),
                text: Color::from_rgb8(36, 37, 40),
                muted: Color::from_rgb8(98, 101, 108),
                accent: Color::from_rgb8(49, 91, 214),
                accent_soft: Color::from_rgb8(233, 237, 249),
                success: Color::from_rgb8(49, 143, 115),
                warning: Color::from_rgb8(169, 105, 25),
                danger: Color::from_rgb8(199, 72, 79),
            },
            Self::Dark => Tokens {
                background: Color::from_rgb8(25, 26, 29),
                sidebar: Color::from_rgba8(22, 23, 26, 0.84),
                surface: Color::from_rgb8(32, 33, 37),
                surface_hover: Color::from_rgb8(50, 52, 58),
                border: Color::from_rgb8(53, 55, 62),
                text: Color::from_rgb8(236, 236, 239),
                muted: Color::from_rgb8(172, 175, 184),
                accent: Color::from_rgb8(139, 169, 255),
                accent_soft: Color::from_rgba8(109, 146, 255, 0.12),
                success: Color::from_rgb8(88, 185, 154),
                warning: Color::from_rgb8(240, 180, 90),
                danger: Color::from_rgb8(225, 103, 103),
            },
        }
    }

    pub fn iced(self) -> Theme {
        let tokens = self.tokens();
        Theme::custom(
            match self {
                Self::Light => "Prospero Light",
                Self::Dark => "Prospero Dark",
            },
            theme::Palette {
                background: tokens.background,
                text: tokens.text,
                primary: tokens.accent,
                success: tokens.success,
                warning: tokens.warning,
                danger: tokens.danger,
            },
        )
    }
}

pub fn panel(mode: Mode) -> impl Fn(&Theme) -> container::Style {
    move |_| {
        let tokens = mode.tokens();
        container::Style {
            background: Some(Background::Color(tokens.surface)),
            text_color: Some(tokens.text),
            border: Border {
                color: tokens.border,
                width: 1.0,
                radius: border::Radius::new(RADIUS_PANEL),
            },
            shadow: Shadow {
                color: Color::from_rgba8(0, 0, 0, 0.12),
                offset: iced::Vector::new(0.0, 8.0),
                blur_radius: 28.0,
            },
            ..Default::default()
        }
    }
}

pub fn sidebar(mode: Mode) -> impl Fn(&Theme) -> container::Style {
    move |_| container::Style {
        background: Some(Background::Color(mode.tokens().sidebar)),
        text_color: Some(mode.tokens().text),
        border: Border {
            color: mode.tokens().border,
            width: 0.0,
            radius: border::Radius::new(0),
        },
        ..Default::default()
    }
}

pub fn terminal(_: &Theme) -> container::Style {
    container::Style {
        background: Some(Background::Color(Color::from_rgb8(26, 27, 38))),
        text_color: Some(Color::from_rgb8(192, 202, 245)),
        border: Border {
            color: Color::from_rgb8(42, 44, 61),
            width: 1.0,
            radius: border::Radius::new(RADIUS_PANEL),
        },
        ..Default::default()
    }
}

pub fn navigation(mode: Mode, selected: bool) -> impl Fn(&Theme, button::Status) -> button::Style {
    move |_, status| {
        let tokens = mode.tokens();
        let background = if selected {
            tokens.accent_soft
        } else if matches!(status, button::Status::Hovered) {
            tokens.surface_hover
        } else {
            Color::TRANSPARENT
        };
        button::Style {
            background: Some(Background::Color(background)),
            text_color: if selected { tokens.accent } else { tokens.text },
            border: Border {
                color: Color::TRANSPARENT,
                width: 0.0,
                radius: border::Radius::new(RADIUS_CONTROL),
            },
            ..Default::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metrics_match_the_frozen_electron_contract() {
        assert_eq!(SIDEBAR_WIDTH, 240.0);
        assert_eq!(NAVIGATION_HEIGHT, 28.0);
        assert_eq!(
            (TEXT_CAPTION, TEXT_SMALL, TEXT_BODY, TEXT_LEAD, TEXT_CHAT),
            (12.0, 13.0, 14.0, 15.0, 16.0)
        );
        assert_eq!((RADIUS_CONTROL, RADIUS_PANEL), (4.0, 6.0));
        assert_eq!(Mode::Light.tokens().accent, Color::from_rgb8(49, 91, 214));
        assert_eq!(Mode::Dark.tokens().accent, Color::from_rgb8(139, 169, 255));
    }
}
