//! What an input shows when its image cannot be read: the input's own value,
//! not the texture's `fallback` (that is for a texture node with no image).

mod common;

use common::scene;
use usd_wasm::Scene;


const MESH: &str = r#"#usda 1.0
def Mesh "Quad" (prepend apiSchemas = ["MaterialBindingAPI"])
{
    int[] faceVertexCounts = [3]
    int[] faceVertexIndices = [0, 1, 2]
    point3f[] points = [(0, 0, 0), (1, 0, 0), (0, 1, 0)]
    rel material:binding = </Mat>
}
"#;

fn value_of(scene: &Scene, input: &str) -> Option<[f32; 3]> {
    let (_, texture) = scene.materials[0].maps.iter().find(|(name, _)| *name == input).expect("textured");
    texture.value
}

#[test]
fn a_textured_preview_input_keeps_its_authored_value_or_the_schema_default() {
    let s = scene(&format!(
        r#"{MESH}
def Material "Mat"
{{
    token outputs:surface.connect = </Mat/Surface.outputs:surface>
    def Shader "Surface"
    {{
        uniform token info:id = "UsdPreviewSurface"
        color3f inputs:diffuseColor = (0, 0, 1)
        color3f inputs:diffuseColor.connect = </Mat/Tex.outputs:rgb>
        float inputs:roughness.connect = </Mat/Tex.outputs:g>
        float inputs:occlusion.connect = </Mat/Tex.outputs:r>
        token outputs:surface
    }}
    def Shader "Tex"
    {{
        uniform token info:id = "UsdUVTexture"
        asset inputs:file = @missing.png@
        float4 inputs:fallback = (1, 0, 0, 1)
        float3 outputs:rgb
        float outputs:r
        float outputs:g
    }}
}}
"#
    ));
    assert_eq!(value_of(&s, "diffuseColor"), Some([0.0, 0.0, 1.0]));
    assert_eq!(value_of(&s, "roughness"), Some([0.5; 3]));
    assert_eq!(value_of(&s, "occlusion"), Some([1.0; 3]));
}

#[test]
fn an_omnipbr_diffuse_texture_falls_back_to_the_diffuse_constant() {
    let s = scene(&format!(
        r#"{MESH}
def Material "Mat"
{{
    token outputs:mdl:surface.connect = </Mat/Shader.outputs:out>
    def Shader "Shader"
    {{
        uniform asset info:mdl:sourceAsset = @OmniPBR.mdl@
        color3f inputs:diffuse_color_constant = (0.3, 0.4, 0.5)
        color3f inputs:diffuse_tint = (1, 1, 1)
        asset inputs:diffuse_texture = @missing.png@
        token outputs:out
    }}
}}
"#
    ));
    assert_eq!(value_of(&s, "diffuseColor"), Some([0.3, 0.4, 0.5]));
}
