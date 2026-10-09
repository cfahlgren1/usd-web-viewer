//! Composes test stages through the same Loader the browser uses.

use usd_wasm::{Composed, Loader, Scene};

/// The scene of a single in-memory layer, triangle data read.
pub fn scene(usda: &str) -> Scene {
    let mut loader = Loader::new();
    loader.add_layer("/h/root.usda", usda.as_bytes().to_vec()).expect("layer parses");
    match loader.compose("/h/root.usda", usize::MAX).expect("composes") {
        Composed::Scene(scene) => scene.read_all().expect("reads geometry"),
        Composed::Missing(missing) => panic!("missing layers: {missing:?}"),
    }
}
