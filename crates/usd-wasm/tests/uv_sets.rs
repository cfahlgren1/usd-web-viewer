//! A texture that names its UV primvar must be sampled with that primvar.

use usd_wasm::{Composed, Loader};

const LAYER: &str = r#"#usda 1.0
def Mesh "Quad" (prepend apiSchemas = ["MaterialBindingAPI"])
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    texCoord2f[] primvars:st = [(0, 0), (0, 0), (0, 0)] (interpolation = "vertex")
    texCoord2f[] primvars:custom = [(1, 1), (1, 1), (1, 1)] (interpolation = "vertex")
    rel material:binding = </Mat>
}
def Material "Mat"
{
    token outputs:surface.connect = </Mat/Surface.outputs:surface>
    def Shader "Surface"
    {
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor.connect = </Mat/Tex.outputs:rgb>
        token outputs:surface
    }
    def Shader "Tex"
    {
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @tex.png@
        float2 inputs:st.connect = </Mat/Reader.outputs:result>
        float3 outputs:rgb
    }
    def Shader "Reader"
    {
        uniform token info:id = "UsdPrimvarReader_float2"
        string inputs:varname = "custom"
        float2 outputs:result
    }
}
"#;

#[test]
fn texture_samples_the_primvar_it_names() {
    let mut loader = Loader::new();
    loader.add_layer("/h/root.usda", LAYER.as_bytes().to_vec()).unwrap();
    let Composed::Scene(scene) = loader.compose("/h/root.usda", usize::MAX).unwrap() else {
        panic!("missing layers");
    };
    let scene = scene.read_all().unwrap();
    let geometry = &scene.geometries[0];
    let texture = &scene.materials[0].maps[0].1;
    assert_eq!(texture.uv_set.as_deref(), Some("custom"));
    let (_, uvs) = geometry
        .uvs
        .iter()
        .find(|(name, _)| name == "custom")
        .expect("the custom UV set is extracted");
    assert_eq!(&uvs[..2], &[1.0, 1.0]);
}
