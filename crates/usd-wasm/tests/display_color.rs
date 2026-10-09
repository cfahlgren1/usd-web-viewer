//! Per-vertex `displayColor` becomes a color attribute; a constant one tints
//! the material instead.

mod common;

use usd_wasm::Scene;

fn scene(display_color: &str) -> Scene {
    common::scene(&format!(
        r#"#usda 1.0
def Mesh "Tri"
{{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    {display_color}
}}
"#
    ))
}

#[test]
fn vertex_display_color_is_a_color_attribute() {
    let s = scene(r#"color3f[] primvars:displayColor = [(1, 0, 0), (0, 1, 0), (0, 0, 1)] (interpolation = "vertex")"#);
    assert_eq!(s.geometries[0].colors, vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0]);
    let m = &s.materials[s.instances[0].material_for(&s.geometries[0].groups[0]) as usize];
    assert_eq!(m.color, [1.0; 3]);
}

#[test]
fn constant_display_color_tints_the_material() {
    let s = scene(r#"color3f[] primvars:displayColor = [(0.5, 0.25, 1)]"#);
    assert!(s.geometries[0].colors.is_empty());
    let m = &s.materials[s.instances[0].material_for(&s.geometries[0].groups[0]) as usize];
    assert_eq!(m.color, [0.5, 0.25, 1.0]);
}

const RGB: [f32; 9] = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];

#[test]
fn a_subset_material_reading_display_color_gets_per_vertex_colors() {
    let s = common::scene(include_str!("../../../fixtures/subset_colors.usda"));
    assert_eq!(s.geometries[0].colors, RGB);
    let names: Vec<_> = s.geometries[0].groups.iter().map(|g| &s.materials[s.instances[0].material_for(g) as usize]).map(|m| (m.path.as_str(), m.color_primvar.as_deref())).collect();
    assert_eq!(names, [("/Mat", Some("displayColor"))]);
}

#[test]
fn a_primvar_reader_varname_names_the_color_primvar() {
    let s = common::scene(include_str!("../../../fixtures/primvar_colors.usda"));
    assert_eq!(s.geometries[0].colors, RGB);
}
