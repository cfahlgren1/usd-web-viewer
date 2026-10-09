//! Implicit gprims (Cube, Sphere, Cylinder, Cone, Capsule, Plane) are drawn as
//! tessellated meshes with the size, axis, transform and material they author.

mod common;

use common::scene;
use usd_wasm::Scene;

/// World-space bounds of an instance (local bounds through its matrix; the
/// tests only translate and scale).
fn bounds(s: &Scene, path: &str) -> [[f32; 3]; 2] {
    let inst = s.instances.iter().find(|i| i.path == path).unwrap_or_else(|| panic!("{path} drawn"));
    let [lo, hi] = s.geometries[inst.geometry as usize].bounds;
    let m = inst.matrix;
    let world = |p: [f32; 3], k: usize| (p[0] as f64 * m[k] + p[1] as f64 * m[4 + k] + p[2] as f64 * m[8 + k] + m[12 + k]) as f32;
    let a = [0, 1, 2].map(|k| world(lo, k));
    let b = [0, 1, 2].map(|k| world(hi, k));
    let round = |v: f32| (v * 1000.0).round() / 1000.0;
    [[0, 1, 2].map(|k| round(a[k].min(b[k]))), [0, 1, 2].map(|k| round(a[k].max(b[k])))]
}

#[test]
fn implicit_gprims_draw_with_their_sizes_and_axes() {
    let s = scene(
        r#"#usda 1.0
def Cube "Cube" { double size = 4 }
def Sphere "Sphere" { double radius = 3 double3 xformOp:translate = (10, 0, 0) uniform token[] xformOpOrder = ["xformOp:translate"] }
def Cylinder "Cylinder" { double radius = 1 double height = 6 uniform token axis = "X" }
def Cone "Cone" { double radius = 2 double height = 4 uniform token axis = "Y" }
def Capsule "Capsule" { double radius = 1 double height = 6 }
def Plane "Plane" { double width = 2 double length = 6 uniform token axis = "X" }
def Sphere "Default" { double3 xformOp:scale = (2, 2, 2) uniform token[] xformOpOrder = ["xformOp:scale"] }
"#,
    );
    assert!(s.warnings.iter().all(|w| w.code != "prim-unsupported"));
    assert_eq!(bounds(&s, "/Cube"), [[-2.0; 3], [2.0; 3]]);
    assert_eq!(bounds(&s, "/Sphere"), [[7.0, -3.0, -3.0], [13.0, 3.0, 3.0]]);
    assert_eq!(bounds(&s, "/Cylinder"), [[-3.0, -1.0, -1.0], [3.0, 1.0, 1.0]]);
    assert_eq!(bounds(&s, "/Cone"), [[-2.0, -2.0, -2.0], [2.0, 2.0, 2.0]]);
    assert_eq!(bounds(&s, "/Capsule"), [[-1.0, -1.0, -4.0], [1.0, 1.0, 4.0]]);
    assert_eq!(bounds(&s, "/Plane"), [[0.0, -3.0, -1.0], [0.0, 3.0, 1.0]]);
    assert_eq!(bounds(&s, "/Default"), [[-2.0; 3], [2.0; 3]]);
    let plane = s.instances.iter().find(|i| i.path == "/Plane").unwrap();
    assert!(plane.double_sided, "planes are double-sided by default");
    for g in &s.geometries {
        assert_eq!(g.normals.len(), g.positions.len());
        // Every triangle winds counterclockwise seen from where its normals point.
        let p = |i: u32| [0, 1, 2].map(|k| g.positions[i as usize * 3 + k]);
        let n = |i: u32| [0, 1, 2].map(|k| g.normals[i as usize * 3 + k]);
        for t in g.indices.chunks_exact(3) {
            let (a, b, c) = (p(t[0]), p(t[1]), p(t[2]));
            let (u, v) = ([0, 1, 2].map(|k| b[k] - a[k]), [0, 1, 2].map(|k| c[k] - a[k]));
            let face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
            let normal = [0, 1, 2].map(|k| n(t[0])[k] + n(t[1])[k] + n(t[2])[k]);
            let dot: f32 = (0..3).map(|k| face[k] * normal[k]).sum();
            assert!(dot > 0.0, "{} triangle {t:?} faces inward", g.source);
        }
    }
}

#[test]
fn implicit_gprims_take_materials_display_color_visibility_and_instancing() {
    let s = scene(
        r#"#usda 1.0
def Material "Red"
{
    token outputs:surface.connect = </Red/Surface.outputs:surface>
    def Shader "Surface"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (1, 0, 0)
        token outputs:surface
    }
}
def Cube "Bound" (prepend apiSchemas = ["MaterialBindingAPI"]) { rel material:binding = </Red> }
def Sphere "Tinted" { color3f[] primvars:displayColor = [(0, 1, 0)] }
def Sphere "Hidden" { token visibility = "invisible" }
def Cube "Guide" { uniform token purpose = "guide" }
def PointInstancer "Instancer"
{
    rel prototypes = </Instancer/Protos/Ball>
    int[] protoIndices = [0, 0]
    point3f[] positions = [(0, 0, 0), (5, 0, 0)]
    def Scope "Protos" { def Sphere "Ball" {} }
}
"#,
    );
    let mut drawn: Vec<&str> = s.instances.iter().map(|i| i.path.as_str()).collect();
    drawn.sort();
    assert_eq!(drawn, ["/Bound", "/Instancer/Protos/Ball[0]", "/Instancer/Protos/Ball[1]", "/Tinted"]);
    let material = |path: &str| &s.materials[s.instances.iter().find(|i| i.path == path).unwrap().material as usize];
    assert_eq!(material("/Bound").path, "/Red");
    assert_eq!(material("/Tinted").color, [0.0, 1.0, 0.0]);
}
