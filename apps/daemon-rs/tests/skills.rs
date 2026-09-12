//! Filesystem behaviour for skill discovery and composer mention expansion.
//! Runs against unique tempdirs so the process-wide 30 s discovery cache
//! never collides between cases. User-home roots are intentionally avoided:
//! HOME is process-global and parallel tests must not mutate it.

use std::fs;
use std::path::Path;

use prosperod_rs::skills::{
    PreparedPrompt, ResolvedSkill, assert_mentions_bound, complete_skills, expand_prompt,
    inject_portable_skills, list_skills, resolve_explicit_skills,
};

fn unique_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "prospero-rs-skills-{}-{}-{}",
        label,
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, contents: &str) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

const SKILL: &str =
    "---\nname: review\ndescription: Review the change\n---\n# Review checklist\nRun the tests.\n";

#[test]
fn discovers_project_skill_with_frontmatter() {
    let dir = unique_dir("discover");
    write(&dir.join(".claude/skills/review/SKILL.md"), SKILL);
    let skills = list_skills(dir.to_str().unwrap());
    let review = skills
        .iter()
        .find(|skill| skill.name == "review")
        .expect("project skill discovered");
    assert_eq!(review.description, "Review the change");
    assert!(review.path.ends_with("SKILL.md"));
    assert_eq!(review.scope, "项目");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn stops_at_git_boundary_and_skips_nested_roots() {
    let dir = unique_dir("git-boundary");
    write(&dir.join(".git"), ""); // worktree .git may be a plain file
    write(
        &dir.join("nested/deep/.claude/skills/deep/SKILL.md"),
        "---\nname: deep\n---\nbody\n",
    );
    let skills = list_skills(dir.to_str().unwrap());
    assert!(
        skills.iter().all(|skill| skill.name != "deep"),
        "roots above the .git boundary must not be scanned: {skills:?}"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn skips_heavy_directories_and_never_descends_into_a_skill() {
    let dir = unique_dir("skip-dirs");
    write(
        &dir.join(".claude/skills/node_modules/evil/SKILL.md"),
        "---\nname: evil\n---\n",
    );
    write(
        &dir.join(".claude/skills/review/references/nested/SKILL.md"),
        "---\nname: nested\n---\n",
    );
    write(&dir.join(".claude/skills/review/SKILL.md"), SKILL);
    let names: Vec<String> = list_skills(dir.to_str().unwrap())
        .into_iter()
        .map(|skill| skill.name)
        .collect();
    assert!(names.contains(&"review".to_owned()));
    assert!(!names.contains(&"evil".to_owned()));
    assert!(!names.contains(&"nested".to_owned()));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn completion_scores_exact_then_prefix_then_description() {
    let dir = unique_dir("complete");
    write(
        &dir.join(".claude/skills/review/SKILL.md"),
        "---\nname: review\ndescription: Review\n---\n",
    );
    write(
        &dir.join(".claude/skills/release/SKILL.md"),
        "---\nname: release\ndescription: cut a release\n---\n",
    );
    let exact = complete_skills(dir.to_str().unwrap(), "review");
    assert_eq!(exact[0].value, "review");
    // User-home roots also contribute, so compare the two project skills'
    // relative order instead of the absolute first position.
    let prefix = complete_skills(dir.to_str().unwrap(), "re");
    let position = |name: &str| {
        prefix
            .iter()
            .position(|item| item.value == name)
            .unwrap_or(usize::MAX)
    };
    assert!(position("release") < position("review"));
    let by_description = complete_skills(dir.to_str().unwrap(), "cut");
    assert_eq!(
        by_description
            .iter()
            .find(|item| item.value == "release")
            .map(|item| item.value.as_str()),
        Some("release")
    );
    assert!(
        !by_description.iter().any(|item| item.value == "review"),
        "description-only match must not surface review"
    );
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn explicit_skills_require_every_name_to_resolve() {
    let dir = unique_dir("explicit");
    write(&dir.join(".claude/skills/review/SKILL.md"), SKILL);
    let resolved = resolve_explicit_skills(dir.to_str().unwrap(), &["REVIEW".to_owned()])
        .expect("names match case-insensitively");
    assert_eq!(resolved[0].name, "review");
    assert!(resolved[0].contents.contains("Review checklist"));

    let error = resolve_explicit_skills(dir.to_str().unwrap(), &["missing".to_owned()])
        .expect_err("unknown skill is a hard error");
    assert!(format!("{error}").contains("找不到显式指定的 Skill: missing"));

    assert_mentions_bound("do $review now", &["review".to_owned()]).unwrap();
    let undeclared = assert_mentions_bound("do $other now", &["review".to_owned()])
        .expect_err("spec $mention must be explicitly bound");
    assert!(format!("{undeclared}").contains("未显式绑定的 Skill: other"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn expands_skill_mention_into_prompt_inline() {
    let dir = unique_dir("expand-skill");
    write(&dir.join(".claude/skills/review/SKILL.md"), SKILL);
    let expanded = expand_prompt(dir.to_str().unwrap(), "请 $review 一下");
    assert!(expanded.contains("[Prospero selected Agent Skills]"));
    assert!(expanded.contains("Review checklist"));
    assert!(expanded.contains("[User request]\n请 $review 一下"));

    // Portable injection wrapper matches the legacy wording.
    let prepared = inject_portable_skills(
        "hi",
        &[ResolvedSkill {
            name: "x".to_owned(),
            description: "test".to_owned(),
            path: "/tmp/SKILL.md".to_owned(),
            contents: "do X".to_owned(),
        }],
    );
    assert!(prepared.contains("--- Skill: x"));
    assert!(prepared.contains("do X"));
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn unknown_skill_mention_stays_plain_text() {
    let dir = unique_dir("expand-unknown");
    let expanded = expand_prompt(dir.to_str().unwrap(), "try $nope please");
    assert_eq!(expanded, "try $nope please");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn resolves_safe_file_mentions_only() {
    let dir = unique_dir("expand-file");
    write(&dir.join("src/main.rs"), "fn main() {}");
    write(&dir.join("notes with space.txt"), "x");

    let prepared: PreparedPrompt =
        prosperod_rs::skills::prepare_composer_prompt(dir.to_str().unwrap(), "see @src/main.rs");
    assert!(prepared.text.contains("- src/main.rs"), "{}", prepared.text);
    assert!(prepared.skills.is_empty());

    let quoted = prosperod_rs::skills::prepare_composer_prompt(
        dir.to_str().unwrap(),
        "see @\"notes with space.txt\"",
    );
    assert!(
        quoted.text.contains("- notes with space.txt"),
        "{}",
        quoted.text
    );

    // Absolute paths, parent traversal and missing files never become references.
    for dangerous in ["@/etc/passwd", "@../secret.txt", "@src/missing.rs"] {
        let prepared =
            prosperod_rs::skills::prepare_composer_prompt(dir.to_str().unwrap(), dangerous);
        assert!(
            !prepared.text.contains("[Prospero file references]"),
            "{dangerous}"
        );
        assert_eq!(prepared.text, dangerous);
    }
    let _ = fs::remove_dir_all(&dir);
}
