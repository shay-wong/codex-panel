use super::{
    features::Context,
    source_ast::{edits, unique, Ast, Edit, Id},
};
use crate::ApiError;

fn error(message: impl Into<String>) -> ApiError {
    ApiError::new(422, "PET_ANIMATION", message)
}

fn same(ast: &Ast, left: Id, right: Id) -> bool {
    let left = ast.unwrap(left);
    let right = ast.unwrap(right);
    if ast.same_binding(left, right) {
        return true;
    }
    let a = ast.value(left);
    let b = ast.value(right);
    if a != left || b != right {
        return same(ast, a, b);
    }
    ast.kind(a) == "MemberExpression"
        && ast.kind(b) == "MemberExpression"
        && ast.name(a) == ast.name(b)
        && ast
            .child(a, "object")
            .zip(ast.child(b, "object"))
            .is_some_and(|(a, b)| same(ast, a, b))
}
fn call(ast: &Ast, node: Id, name: &str) -> bool {
    ast.kind(node) == "CallExpression"
        && ast
            .child(node, "callee")
            .is_some_and(|callee| ast.name(ast.unwrap(callee)).as_deref() == Some(name))
}
pub fn catalogs(ast: &Ast) -> Vec<Id> {
    ast.all(ast.root, |node| {
        ast.kind(node) == "ArrayExpression"
            && ast.array(node, "elements").iter().any(|node| {
                ast.kind(*node) == "ObjectExpression"
                    && ast
                        .property_value(*node, "assetRef")
                        .is_some_and(|node| ast.field(node, "value") == "codex")
                    && ast
                        .property_value(*node, "description")
                        .is_some_and(|node| {
                            ast.field(node, "value") == "The original Codex companion."
                        })
            })
    })
}
fn cloud_predicates(ast: &Ast) -> Vec<Id> {
    if ast
        .all(ast.root, |node| {
            call(ast, node, "safePatch")
                && ast.array(node, "arguments").first().is_some_and(|node| {
                    ast.field(*node, "value") == "/settings/account_user_setting"
                })
        })
        .is_empty()
    {
        return Vec::new();
    }
    ast.all(ast.root, |function| {
        if !ast.is_function(function) {
            return false;
        }
        let parameters = ast.array(function, "params");
        if parameters.len() != 1 || ast.kind(parameters[0]) != "Identifier" {
            return false;
        }
        let parameter = parameters[0];
        let calls = ast.all(function, |node| {
            ast.kind(node) == "CallExpression"
                && ast.enclosing(node, |node| ast.is_function(node)) == Some(function)
        });
        calls.iter().any(|node| {
            call(ast, *node, "startsWith")
                && ast
                    .array(*node, "arguments")
                    .first()
                    .is_some_and(|node| ast.field(*node, "value") == "pet_")
                && ast
                    .child(*node, "callee")
                    .map(|node| ast.unwrap(node))
                    .and_then(|node| ast.child(node, "object"))
                    .is_some_and(|node| same(ast, node, parameter))
        }) && calls.iter().any(|node| {
            if !call(ast, *node, "some") {
                return false;
            }
            let Some(predicate) = ast
                .array(*node, "arguments")
                .first()
                .map(|node| ast.value(*node))
            else {
                return false;
            };
            if !ast.is_function(predicate) {
                return false;
            }
            let Some(pet) = ast.array(predicate, "params").first().copied() else {
                return false;
            };
            let id = ast.property_value(pet, "id");
            !ast.all(predicate, |node| {
                if ast.kind(node) != "BinaryExpression"
                    || !matches!(ast.field(node, "operator").as_str(), Some("===" | "=="))
                {
                    return false;
                }
                let (Some(left), Some(right)) = (ast.child(node, "left"), ast.child(node, "right"))
                else {
                    return false;
                };
                let matches = |left, right| {
                    same(ast, right, parameter)
                        && (id.is_some_and(|id| same(ast, left, id))
                            || ast.kind(left) == "MemberExpression"
                                && ast.name(left).as_deref() == Some("id")
                                && ast
                                    .child(left, "object")
                                    .is_some_and(|object| same(ast, object, pet)))
                };
                matches(left, right) || matches(right, left)
            })
            .is_empty()
        })
    })
}
fn uses(ast: &Ast, name: &str) -> bool {
    !ast.all(ast.root, |node| {
        call(ast, node, name)
            && ast
                .child(node, "callee")
                .map(|node| ast.unwrap(node))
                .and_then(|node| ast.child(node, "object"))
                .map(|node| ast.value(node))
                .is_some_and(|node| {
                    ast.name(node).as_deref() == Some("__codexPanelPetAnimations__")
                })
    })
    .is_empty()
}

fn property_input(ast: &Ast, function: Id, source: Id, name: &str) -> Result<String, ApiError> {
    let patterns = ast.all(function, |node| {
        ast.kind(node) == "ObjectPattern"
            && ast
                .property_value(node, "source")
                .is_some_and(|node| same(ast, node, source))
            && ast.property_value(node, name).is_some()
    });
    if patterns.len() == 1 {
        let value = ast.property_value(patterns[0], name).unwrap();
        let value = if ast.kind(value) == "AssignmentPattern" {
            ast.child(value, "left").unwrap()
        } else {
            value
        };
        return Ok(ast.text(value).into());
    }
    let resolved = ast.value(source);
    if ast.kind(resolved) == "MemberExpression" && ast.name(resolved).as_deref() == Some("source") {
        return Ok(format!(
            "{}.{name}",
            ast.text(ast.child(resolved, "object").unwrap())
        ));
    }
    Err(error(format!("Native pet {name} input is unsupported")))
}

fn renderer_edits(ast: &Ast, props: Id) -> Result<Vec<Edit>, ApiError> {
    let component = ast
        .enclosing(props, |node| ast.is_function(node))
        .ok_or_else(|| error("Native pet component is unavailable"))?;
    let source = ast
        .property_value(props, "data-codex-pet-asset-ref")
        .map(|node| ast.unwrap(node))
        .and_then(|node| ast.child(node, "object"))
        .ok_or_else(|| error("Native pet source is unavailable"))?;
    let state = ast
        .property_value(props, "data-codex-pet-state")
        .ok_or_else(|| error("Native pet state is unavailable"))?;
    let reference = ast
        .property_value(props, "ref")
        .ok_or_else(|| error("Native pet ref is unavailable"))?;
    let style = ast
        .property_value(props, "style")
        .map(|node| ast.value(node))
        .filter(|node| ast.kind(*node) == "ObjectExpression")
        .ok_or_else(|| error("Native pet style is unavailable"))?;
    let look = property_input(ast, component, source, "lookFrame")?;
    let looping = property_input(ast, component, source, "loop")?;
    let effects = ast
        .all(component, |node| {
            call(ast, node, "useEffect")
                && ast.enclosing(node, |node| ast.is_function(node)) == Some(component)
        })
        .into_iter()
        .filter(|node| {
            ast.array(*node, "arguments")
                .first()
                .map(|node| ast.value(*node))
                .is_some_and(|callback| {
                    ast.is_function(callback)
                        && !ast
                            .all(callback, |node| {
                                ast.kind(node) == "MemberExpression"
                                    && ast.name(node).as_deref() == Some("current")
                                    && ast
                                        .child(node, "object")
                                        .is_some_and(|node| same(ast, node, reference))
                            })
                            .is_empty()
                })
        })
        .collect();
    let effect = unique(effects, "Native pet animation effect is unsupported")?;
    let args = ast.array(effect, "arguments");
    if args.len() < 2 {
        return Err(error("Native pet effect dependencies are unavailable"));
    }
    let callback = ast.value(args[0]);
    let dependencies = ast.value(args[1]);
    let mut sequences = ast
        .all(callback, |node| {
            ast.kind(node) == "MemberExpression" && ast.name(node).as_deref() == Some("frames")
        })
        .into_iter()
        .filter_map(|node| ast.child(node, "object"))
        .map(|node| ast.value(node))
        .filter(|node| {
            let args = ast.array(*node, "arguments");
            ast.kind(*node) == "CallExpression"
                && args.len() == 3
                && args.iter().any(|node| same(ast, *node, state))
                && args.iter().any(|node| ast.text(*node) == looping)
        })
        .collect::<Vec<_>>();
    sequences.sort();
    sequences.dedup();
    let sequence = unique(sequences, "Native pet animation sequence is unsupported")?;
    let reduced = unique(
        ast.array(sequence, "arguments")
            .into_iter()
            .filter(|node| !same(ast, *node, state) && ast.text(*node) != looping)
            .collect(),
        "Native pet reduced-motion input is unsupported",
    )?;
    let hooks = ast
        .child(effect, "callee")
        .map(|node| ast.unwrap(node))
        .and_then(|node| ast.child(node, "object"))
        .ok_or_else(|| error("Native pet hooks are unavailable"))?;
    let image = ast
        .property_value(style, "backgroundImage")
        .ok_or_else(|| error("Native pet background is unavailable"))?;
    let size = ast
        .property_value(style, "backgroundSize")
        .ok_or_else(|| error("Native pet background size is unavailable"))?;
    if ast.kind(dependencies) != "ArrayExpression" {
        return Err(error("Native pet effect dependency array is unavailable"));
    }
    let resolve = format!(
        "panelPetRuntime.resolve(panelPetSnapshot,{},{},{look})",
        ast.text(source),
        ast.text(state)
    );
    let declarations=format!("let panelPetRuntime=globalThis.__codexPanelPetAnimations__,panelPetSnapshot=(0,{}.useSyncExternalStore)(panelPetRuntime.subscribe,panelPetRuntime.getSnapshot);",ast.text(hooks));
    let playback=format!("const panelPetAnimation={resolve};if(panelPetAnimation){{const panelPetElement={}.current;if(panelPetElement!=null)return panelPetRuntime.play(panelPetElement,panelPetAnimation,{},{looping});}}",ast.text(reference),ast.text(reduced));
    let styled=edits(ast.text(style),vec![Edit{start:ast.start(image)-ast.start(style),end:ast.end(image)-ast.start(style),text:format!("panelPetAnimation?`url(${{panelPetAnimation.pack.spritesheetUrl}})`:({})",ast.text(image))},Edit{start:ast.start(size)-ast.start(style),end:ast.end(size)-ast.start(style),text:format!("panelPetAnimation?`${{100*panelPetAnimation.pack.columns}}% ${{100*panelPetAnimation.pack.rows}}%`:({})",ast.text(size))}])?;
    let mut changes = vec![
        Edit {
            start: ast.start(style),
            end: ast.end(style),
            text: format!("((panelPetAnimation)=>({styled}))({resolve})"),
        },
        Edit {
            start: ast.start(dependencies),
            end: ast.end(dependencies),
            text: format!(
                "[...({}),panelPetSnapshot,{}.petId,{}.assetRef]",
                ast.text(dependencies),
                ast.text(source),
                ast.text(source)
            ),
        },
    ];
    for (function, prefix) in [(component, declarations), (callback, playback)] {
        let body = ast.child(function, "body").unwrap();
        if ast.kind(body) == "BlockStatement" {
            let start = ast
                .array(body, "body")
                .into_iter()
                .find(|node| !ast.field(*node, "directive").is_string())
                .map(|node| ast.start(node))
                .unwrap_or(ast.end(body) - 1);
            changes.push(Edit {
                start,
                end: start,
                text: prefix,
            });
        } else {
            changes.push(Edit {
                start: ast.start(body),
                end: ast.start(body),
                text: format!("{{{prefix}return ("),
            });
            changes.push(Edit {
                start: ast.end(body),
                end: ast.end(body),
                text: ");}".into(),
            });
        }
    }
    Ok(changes)
}

pub fn rewrite(source: &str, _module: &str, context: &Context) -> Result<Option<String>, ApiError> {
    if ![
        "The original Codex companion.",
        "/settings/account_user_setting",
        "data-codex-pet-state",
    ]
    .iter()
    .any(|term| source.contains(term))
    {
        return Ok(None);
    }
    let ast = Ast::parse(source, true)?;
    let mut changes = Vec::new();
    let values = catalogs(&ast);
    if !values.is_empty() && !uses(&ast, "bindCatalog") {
        let mut renderer = false;
        for module in context.modules_containing("data-codex-pet-state") {
            let tree = context.ast(&module)?;
            if !tree
                .all(tree.root, |node| {
                    tree.kind(node) == "Property"
                        && tree.name(node).as_deref() == Some("data-codex-pet-state")
                })
                .is_empty()
            {
                renderer = true;
            }
        }
        if !renderer {
            return Err(error("Native pet renderer is unsupported"));
        }
        let value = unique(values, "Native built-in pet catalog is unsupported")?;
        changes.push(Edit{start:ast.start(value),end:ast.end(value),text:format!("((panelPetCatalog)=>(globalThis.__codexPanelPetAnimations__.bindCatalog(panelPetCatalog),panelPetCatalog))({})",ast.text(value))});
    }
    let predicates = cloud_predicates(&ast);
    if !predicates.is_empty() && !uses(&ast, "isLocalPet") {
        let predicate = unique(predicates, "Native cloud pet selection is unsupported")?;
        let parameter = ast.array(predicate, "params")[0];
        let body = ast.child(predicate, "body").unwrap();
        let returns = if ast.kind(body) == "BlockStatement" {
            ast.all(body, |node| {
                ast.kind(node) == "ReturnStatement"
                    && ast.enclosing(node, |node| ast.is_function(node)) == Some(predicate)
            })
            .into_iter()
            .filter_map(|node| ast.child(node, "argument"))
            .collect()
        } else {
            vec![body]
        };
        for value in returns {
            changes.push(Edit {
                start: ast.start(value),
                end: ast.end(value),
                text: format!(
                    "(!globalThis.__codexPanelPetAnimations__.isLocalPet({})&&({}))",
                    ast.text(parameter),
                    ast.text(value)
                ),
            });
        }
    }
    let renderers = ast.all(ast.root, |node| {
        ast.kind(node) == "ObjectExpression"
            && ast.property_value(node, "data-codex-pet-state").is_some()
    });
    if !renderers.is_empty() && !uses(&ast, "resolve") {
        let mut builtin = false;
        for module in context.modules_containing("The original Codex companion.") {
            if !catalogs(context.ast(&module)?.as_ref()).is_empty() {
                builtin = true;
            }
        }
        let mut cloud = false;
        for module in context.modules_containing("cloud-pet-selection") {
            if !cloud_predicates(context.ast(&module)?.as_ref()).is_empty() {
                cloud = true;
            }
        }
        if !builtin || !cloud {
            return Err(error("Native built-in pet selection is unsupported"));
        }
        changes.extend(renderer_edits(
            &ast,
            unique(renderers, "Native pet renderer is unsupported")?,
        )?);
    }
    if changes.is_empty() {
        Ok(None)
    } else {
        Ok(Some(edits(source, changes)?))
    }
}

#[cfg(test)]
mod tests {
    use super::super::adapters::{Catalog, Module, Variant};
    use super::*;
    use serde_json::json;
    #[test]
    fn native_renderer_uses_custom_grid_without_changing_native_pet() {
        let original = include_str!("../../../test/codex-rspack-pets.test.mjs");
        let line = original
            .lines()
            .find(|line| line.starts_with("const nativeSource = "))
            .unwrap();
        let native: String = serde_json::from_str(
            line.trim_start_matches("const nativeSource = ")
                .trim_end_matches(';'),
        )
        .unwrap();
        let catalog="function(m,e,r){const pets=[{assetRef:'codex',description:'The original Codex companion.'}];r.d(e,{pets:()=>pets})}";
        let cloud="function(m,e,r){const label='cloud-pet-selection';const pets=[];function valid(id){return id.startsWith('pet_')||pets.some(({id:other})=>other===id)}function select(id){if(valid(id))client.safePatch('/settings/account_user_setting',{value:id})}r.d(e,{select:()=>select})}";
        let modules = [
            ("renderer", native.clone()),
            ("catalog", catalog.into()),
            ("cloud", cloud.into()),
        ]
        .into_iter()
        .map(|(id, source)| {
            (
                id.into(),
                Module {
                    source: source.clone(),
                    exports: Vec::new(),
                    variants: vec![Variant {
                        source,
                        chunks: Vec::new(),
                        asset_size: 0,
                    }],
                },
            )
        })
        .collect();
        let catalog = Catalog {
            main_url_path: String::new(),
            main_source: String::new(),
            digest: String::new(),
            modules,
            unreadable: Vec::new(),
        };
        let rewritten = rewrite(&native, "renderer", &Context::new(&catalog))
            .unwrap()
            .unwrap();
        Ast::parse(&rewritten, true).unwrap();
        let render_start = original.find("function render(").unwrap();
        let render_end = original[render_start..].find("\ntest(").unwrap() + render_start;
        let renderer = &original[render_start..render_end];
        let script = format!(
            r#"const assert=require('node:assert/strict'),vm=require('node:vm');const createPetAnimationRuntime={};const pack={{petId:'custom-pet',columns:4,rows:3,spritesheetUrl:'data:image/webp;base64,fixture',animations:{{idle:{{frames:[[9,1680],[10,660]],loop:true}},jumping:{{frames:[[8,938],[0,59],[1,58],[2,59]],loop:false}}}},lookFrames:Array.from({{length:16}},(_,i)=>i%12)}};{};const source={};const playing=render(source,[pack],{{hover:true}});assert.equal(playing.output.props.style.backgroundSize,'400% 300%');assert.equal(playing.output.props.style.backgroundImage,'url('+pack.spritesheetUrl+')');playing.advance(938);assert.equal(playing.element.style.backgroundPosition,'0% 0%');playing.cleanup();const before=render({},[],{{petId:'native'}}),after=render(source,[pack],{{petId:'native'}});assert.deepEqual({{...after.output.props.style}},{{...before.output.props.style}});before.cleanup?.();after.cleanup?.();"#,
            include_str!("assets/pet_runtime.js"),
            renderer,
            json!(rewritten),
            json!(native)
        );
        let output = std::process::Command::new("node")
            .args(["-e", &script])
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
