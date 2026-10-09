//! Extraction from in-memory USDA stages, through the same Loader the browser uses.

use usd_wasm::{Composed, Loader, Scene};

fn scene(usda: &str) -> Scene {
    let mut loader = Loader::new();
    loader.add_layer("/h/root.usda", usda.as_bytes().to_vec()).expect("layer parses");
    match loader.compose("/h/root.usda").expect("composes") {
        Composed::Scene(scene) => scene,
        Composed::Missing(missing) => panic!("missing layers: {missing:?}"),
    }
}

/// Two quads side by side in the XY plane.
const TWO_QUADS: &str = r#"
        int[] faceVertexCounts = [4, 4]
        int[] faceVertexIndices = [0, 1, 4, 3, 1, 2, 5, 4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (2, 0, 0), (0, 1, 0), (1, 1, 0), (2, 1, 0)]
"#;

fn mesh(body: &str) -> String {
    format!("#usda 1.0\ndef Mesh \"M\"\n{{\n{body}\n}}\n")
}

#[test]
fn hole_faces_are_not_drawn() {
    let s = scene(&mesh(&format!("{TWO_QUADS}\n        int[] holeIndices = [1]")));
    assert_eq!(s.stats.triangles, 2);
    assert_eq!(s.geometries[0].indices.len(), 6);
}
