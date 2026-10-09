//! The asset paths one layer authors: what a loader prefetches before composing.

use std::collections::HashMap;

use openusd::sdf::{self, AbstractData, Value};

/// An asset path a layer names, anchored to an identifier.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dependency {
    pub path: String,
    /// Named by a sublayer, reference or payload (a layer), rather than by an
    /// asset-valued attribute (a texture, an MDL module).
    pub arc: bool,
    /// Authored inside a variant that this layer does not select, so only
    /// needed if a stronger layer selects it.
    pub in_variant: bool,
}

/// Lists the sublayers, references, payloads and asset-valued attribute
/// defaults `data` authors. Fields are read selectively by name so bulk
/// arrays are never decoded; a field that fails to decode is skipped rather
/// than failing the walk (composition reports real problems later).
pub fn layer_dependencies(data: &dyn AbstractData, anchor: &str) -> Vec<Dependency> {
    let mut out: Vec<Dependency> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut push = |path: &str, arc: bool, in_variant: bool| {
        let Some(path) = crate::resolver::anchor_path(path, Some(anchor)) else {
            return;
        };
        match seen.get(&path) {
            // A path needed outside any variant is needed unconditionally.
            Some(&i) => out[i].in_variant &= in_variant,
            None => {
                seen.insert(path.clone(), out.len());
                out.push(Dependency { path, arc, in_variant });
            }
        }
    };

    for spec in data.spec_paths() {
        let in_variant = !selected_here(data, spec.as_str());
        let field = |name: &str| data.try_field(&spec, name).ok().flatten();

        if let Some(value) = field("subLayers")
            && let Value::StringVec(paths) = &*value
        {
            for path in paths {
                push(path, true, false);
            }
        }
        if let Some(value) = field("references")
            && let Value::ReferenceListOp(op) = &*value
        {
            for item in live_items(op) {
                push(&item.asset_path, true, in_variant);
            }
        }
        if let Some(value) = field("payload") {
            match &*value {
                Value::PayloadListOp(op) => {
                    for item in live_items(op) {
                        push(&item.asset_path, true, in_variant);
                    }
                }
                Value::Payload(item) => push(&item.asset_path, true, in_variant),
                _ => {}
            }
        }
        let is_asset_attr = field("typeName").is_some_and(|v| match &*v {
            Value::Token(t) => t.as_str() == "asset" || t.as_str() == "asset[]",
            Value::String(s) => s == "asset" || s == "asset[]",
            _ => false,
        });
        if is_asset_attr && let Some(value) = field("default") {
            match &*value {
                Value::AssetPath(a) => push(a.as_str(), false, in_variant),
                Value::AssetPathVec(list) => {
                    for a in list {
                        push(a.as_str(), false, in_variant);
                    }
                }
                _ => {}
            }
        }
    }
    out
}

/// Whether every variant on the way to `spec` (`/A{set=sel}B{set2=sel2}`) is
/// the one the same layer selects. Stronger layers can still select another
/// variant; composition then reports what is missing.
fn selected_here(data: &dyn AbstractData, spec: &str) -> bool {
    let mut rest = spec;
    let mut prefix = String::new();
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|c| open + c) else {
            return false;
        };
        prefix.push_str(&rest[..open]);
        let Some((set, choice)) = rest[open + 1..close].split_once('=') else {
            return false;
        };
        let Ok(owner) = sdf::Path::new(&prefix) else {
            return false;
        };
        let selection = match data.try_field(&owner, "variantSelection").ok().flatten().as_deref() {
            Some(Value::VariantSelectionMap(map)) => map.get(set).cloned(),
            _ => None,
        };
        if selection.as_deref() != Some(choice) {
            return false;
        }
        prefix.push_str(&rest[open..=close]);
        rest = &rest[close + 1..];
    }
    true
}

/// Items a list op adds; deleted items add no opinion.
fn live_items<T: Default + Clone + PartialEq>(op: &sdf::ListOp<T>) -> impl Iterator<Item = &T> {
    op.explicit_items
        .iter()
        .chain(&op.prepended_items)
        .chain(&op.appended_items)
        .chain(&op.added_items)
}
