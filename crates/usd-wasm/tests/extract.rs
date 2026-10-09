//! Extraction from in-memory USDA stages, through the same Loader the browser uses.

use usd_wasm::{Composed, Loader, Scene};

fn scene(usda: &str) -> Scene {
    let mut loader = Loader::new();
    loader
        .add_layer("/h/root.usda", usda.as_bytes().to_vec())
        .expect("layer parses");
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

/// Two quads folded 90 degrees along x = 1: one faces +Z, the other +X.
const FOLD: &str = r#"
        int[] faceVertexCounts = [4, 4]
        int[] faceVertexIndices = [0, 1, 4, 3, 1, 2, 5, 4]
        point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 0, -1), (0, 1, 0), (1, 1, 0), (1, 1, -1)]
"#;

/// The normal at each output vertex, rounded to whole numbers.
fn vertex_normals(s: &Scene) -> Vec<[i32; 3]> {
    s.geometries[0]
        .normals
        .chunks(3)
        .map(|n| [n[0], n[1], n[2]].map(|v| v.round() as i32))
        .collect()
}

#[test]
fn polygonal_mesh_without_normals_is_faceted() {
    let s = scene(&mesh(&format!(
        "{FOLD}\n        uniform token subdivisionScheme = \"none\""
    )));
    let normals = vertex_normals(&s);
    assert_eq!(normals.len(), 8, "the shared edge is split");
    let indices = &s.geometries[0].indices;
    for tri in indices.chunks(3).take(2) {
        assert!(tri.iter().all(|&v| normals[v as usize] == [0, 0, 1]));
    }
    for tri in indices.chunks(3).skip(2) {
        assert!(tri.iter().all(|&v| normals[v as usize] == [1, 0, 0]));
    }
}

#[test]
fn subdivision_mesh_without_normals_stays_smooth() {
    let s = scene(&mesh(FOLD));
    assert_eq!(vertex_normals(&s).len(), 6, "points are shared");
}

fn uvs(s: &Scene) -> Vec<[f32; 2]> {
    s.geometries[0].uvs.chunks(2).map(|uv| [uv[0], uv[1]]).collect()
}

#[test]
fn primvar_without_interpolation_is_constant() {
    let s = scene(&mesh(&format!(
        "{TWO_QUADS}\n        texCoord2f[] primvars:st = [(0.25, 0.75)]"
    )));
    let uvs = uvs(&s);
    assert_eq!(uvs.len(), 6);
    assert!(uvs.iter().all(|&uv| uv == [0.25, 0.75]));
}

#[test]
fn normals_primvar_without_interpolation_is_constant() {
    let s = scene(&mesh(&format!(
        "{FOLD}\n        normal3f[] primvars:normals = [(0, 1, 0)]"
    )));
    assert!(vertex_normals(&s).iter().all(|&n| n == [0, 1, 0]));
}

#[test]
fn normals_attribute_without_interpolation_is_per_vertex() {
    let s = scene(&mesh(&format!(
        "{TWO_QUADS}\n        normal3f[] normals = [(0, 0, 1), (0, 1, 0), (0, 0, 1), (0, 0, 1), (0, 1, 0), (0, 0, 1)]"
    )));
    let n = vertex_normals(&s);
    assert_eq!(n.len(), 6);
    assert_eq!(n[1], [0, 1, 0]);
    assert_eq!(n[0], [0, 0, 1]);
}
