//! Per-vertex `displayColor` becomes a color attribute; a constant one tints
//! the material instead.

use usd_wasm::{Composed, Loader, Scene};

fn scene(display_color: &str) -> Scene {
    let layer = format!(
        r#"#usda 1.0
def Mesh "Tri"
{{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    {display_color}
}}
"#
    );
    let mut loader = Loader::new();
    loader.add_layer("/h/root.usda", layer.into_bytes()).unwrap();
    match loader.compose("/h/root.usda").unwrap() {
        Composed::Scene(scene) => scene,
        Composed::Missing(_) => panic!("missing layers"),
    }
}

#[test]
fn vertex_display_color_is_a_color_attribute() {
    let s = scene(r#"color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0), (0, 0, 1)] (interpolation = "vertex")"#);
    assert_eq!(s.geometries[0].colors, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    let m = &s.materials[s.instances[0].materials[0] as usize];
    assert_eq!(m.color, [1.0; 3]);
}

#[test]
fn constant_display_color_tints_the_material() {
    let s = scene(r#"color3f[] primvars:displayColor = [(0.5, 0.25, 1)]"#);
    assert!(s.geometries[0].colors.is_empty());
    let m = &s.materials[s.instances[0].materials[0] as usize];
    assert_eq!(m.color, [0.5, 0.25, 1.0]);
}
