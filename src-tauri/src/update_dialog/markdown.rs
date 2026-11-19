use objc2::{rc::Retained, runtime::AnyObject, AnyThread, MainThreadMarker};
use objc2_app_kit::{
    NSColor, NSFont, NSFontAttributeName, NSFontManager, NSFontTraitMask,
    NSForegroundColorAttributeName,
};
use objc2_foundation::{NSMutableAttributedString, NSAttributedString, NSDictionary, NSString};
use pulldown_cmark::{CowStr, Event, HeadingLevel, Parser, Tag, TagEnd};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct TextStyle {
    heading: Option<HeadingLevel>,
    bold: usize,
    italic: usize,
    code: bool,
}

fn render(notes: &str, mut append: impl FnMut(&str, TextStyle)) {
    let mut style = TextStyle::default();
    let mut lists: Vec<Option<u64>> = Vec::new();
    let mut at_line_start = true;
    let mut code_block = false;

    for event in Parser::new(notes) {
        let fragment = match event {
            Event::Start(Tag::Heading { level, .. }) => {
                style.heading = Some(level);
                continue;
            }
            Event::End(TagEnd::Heading(_)) => {
                style.heading = None;
                CowStr::Borrowed("\n\n")
            }
            Event::Start(Tag::Strong) => {
                style.bold += 1;
                continue;
            }
            Event::End(TagEnd::Strong) => {
                style.bold -= 1;
                continue;
            }
            Event::Start(Tag::Emphasis) => {
                style.italic += 1;
                continue;
            }
            Event::End(TagEnd::Emphasis) => {
                style.italic -= 1;
                continue;
            }
            Event::Start(Tag::CodeBlock(_)) => {
                code_block = true;
                continue;
            }
            Event::End(TagEnd::CodeBlock) => {
                code_block = false;
                CowStr::Borrowed("\n")
            }
            Event::Start(Tag::List(number)) => {
                lists.push(number);
                if at_line_start {
                    continue;
                }
                CowStr::Borrowed("\n")
            }
            Event::Start(Tag::Item) => {
                let indent = "    ".repeat(lists.len() - 1);
                let marker = match lists.last_mut() {
                    Some(Some(number)) => {
                        let marker = format!("{number}.");
                        *number += 1;
                        marker
                    }
                    _ => "•".to_owned(),
                };
                CowStr::from(format!("{indent}{marker} "))
            }
            Event::End(TagEnd::Item) if !at_line_start => CowStr::Borrowed("\n"),
            Event::End(TagEnd::List(_)) => {
                lists.pop();
                if !lists.is_empty() {
                    continue;
                }
                CowStr::Borrowed("\n")
            }
            Event::End(TagEnd::Paragraph) if lists.is_empty() => CowStr::Borrowed("\n\n"),
            Event::End(TagEnd::Paragraph) | Event::HardBreak => CowStr::Borrowed("\n"),
            Event::SoftBreak => CowStr::Borrowed(" "),
            Event::Text(text) => text,
            Event::Code(text) => {
                append(&text, TextStyle { code: true, ..style });
                at_line_start = false;
                continue;
            }
            Event::Rule => CowStr::Borrowed("────\n\n"),
            // 发行版说明只做展示，链接保留文字，HTML 和图片地址不会进入原生视图。
            _ => continue,
        };
        append(&fragment, TextStyle { code: code_block, ..style });
        at_line_start = fragment.ends_with('\n');
    }
}

pub(super) fn release_notes(
    notes: &str,
    mtm: MainThreadMarker,
) -> Retained<NSMutableAttributedString> {
    let result = NSMutableAttributedString::new();
    let color = NSColor::textColor();
    let font_manager = NSFontManager::sharedFontManager(mtm);
    result.beginEditing();
    render(notes, |fragment, style| {
        let size = match style.heading {
            Some(HeadingLevel::H1) => 17.0,
            Some(HeadingLevel::H2) => 15.0,
            Some(_) => 13.0,
            None => 12.0,
        };
        let font = if style.code {
            NSFont::monospacedSystemFontOfSize_weight(size, 0.0)
        } else if style.bold > 0 || style.heading.is_some() {
            NSFont::boldSystemFontOfSize(size)
        } else {
            NSFont::systemFontOfSize(size)
        };
        let font = if style.italic > 0 {
            font_manager.convertFont_toHaveTrait(&font, NSFontTraitMask::ItalicFontMask)
        } else {
            font
        };
        let fragment = unsafe {
            // AppKit 的字体和颜色属性分别接收 NSFont、NSColor。
            let attributes = NSDictionary::<NSString, AnyObject>::from_slices(
                &[NSFontAttributeName, NSForegroundColorAttributeName],
                &[&font, &color],
            );
            NSAttributedString::initWithString_attributes(
                NSAttributedString::alloc(),
                &NSString::from_str(fragment),
                Some(&attributes),
            )
        };
        result.appendAttributedString(&fragment);
    });
    result.endEditing();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_release_notes_as_styled_text() {
        let mut rendered = String::new();
        let mut heading = None;
        let mut inline_styles = Vec::new();
        render(
            "## 更新内容\n\n- **修复** *说明* `Panel` [发行版](https://example.com)\n\n3. Changes\n\n<script>hidden()</script>",
            |text, style| {
                rendered.push_str(text);
                match text {
                    "更新内容" => heading = style.heading,
                    "修复" => inline_styles.push(style.bold == 1),
                    "说明" => inline_styles.push(style.italic == 1),
                    "Panel" => inline_styles.push(style.code),
                    _ => {}
                }
            },
        );
        assert_eq!(rendered, "更新内容\n\n• 修复 说明 Panel 发行版\n\n3. Changes\n\n");
        assert_eq!(heading, Some(HeadingLevel::H2));
        assert_eq!(inline_styles, [true; 3]);
    }
}
