//! Reduces bound materials to the handful of PBR parameters a web renderer uses.
//!
//! `UsdPreviewSurface` networks are read as specified. Materials that only carry
//! an MDL surface are read by their parameter names for the two MDL modules
//! SimReady content uses most (`OmniPBR` and the glTF `pbr.mdl`); no MDL code is
//! ever loaded or run. Anything else falls back to neutral grey so geometry
//! always shows.

use std::collections::HashMap;

use openusd::sdf::{self, Value};
use openusd::usd::Stage;

#[derive(Clone, Debug, PartialEq)]
pub struct Material {
    pub path: String,
    /// `preview`, `omnipbr`, `gltf-pbr`, `displayColor` or `fallback`.
    pub kind: &'static str,
    pub color: [f32; 3],
    pub opacity: f32,
    pub roughness: f32,
    pub metallic: f32,
    pub emissive: [f32; 3],
    pub color_map: Option<Texture>,
    pub normal_map: Option<Texture>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Texture {
    /// Virtual path of the image file.
    pub path: String,
    /// `primvars:<name>` the texture is sampled with, when it says.
    pub uv_set: Option<String>,
    /// UV transform from `UsdTransform2d` / MDL texture scale, when authored.
    pub scale: [f32; 2],
}

impl Material {
    fn neutral(path: String, kind: &'static str, color: [f32; 3]) -> Self {
        Self {
            path,
            kind,
            color,
            opacity: 1.0,
            roughness: 0.5,
            metallic: 0.0,
            emissive: [0.0; 3],
            color_map: None,
            normal_map: None,
        }
    }
}

/// Materials converted so far, by material prim path.
#[derive(Default)]
pub struct Cache {
    by_path: HashMap<String, u32>,
    by_color: HashMap<[u32; 3], u32>,
}

impl Cache {
    pub fn get(&mut self, stage: &Stage, path: &sdf::Path, out: &mut Vec<Material>) -> openusd::Result<u32> {
        if let Some(&index) = self.by_path.get(path.as_str()) {
            return Ok(index);
        }
        let material = read_material(stage, path)?;
        let index = out.len() as u32;
        out.push(material);
        self.by_path.insert(path.as_str().to_owned(), index);
        Ok(index)
    }

    /// A material for unbound geometry: its `displayColor`, else neutral grey.
    pub fn display_color(&mut self, color: Option<[f32; 3]>, out: &mut Vec<Material>) -> u32 {
        let (kind, color) = match color {
            Some(c) => ("displayColor", c),
            None => ("fallback", [0.7, 0.7, 0.7]),
        };
        let key = color.map(f32::to_bits);
        *self.by_color.entry(key).or_insert_with(|| {
            out.push(Material::neutral(String::new(), kind, color));
            out.len() as u32 - 1
        })
    }
}

fn read_material(stage: &Stage, path: &sdf::Path) -> openusd::Result<Material> {
    let name = path.as_str().to_owned();
    if let Some(shader) = surface_shader(stage, path, "outputs:surface")?
        && shader_id(stage, &shader)?.as_deref() == Some("UsdPreviewSurface")
    {
        return read_preview_surface(stage, &shader, name);
    }
    if let Some(shader) = surface_shader(stage, path, "outputs:mdl:surface")? {
        let prim = stage.prim(&shader)?;
        if prim.attribute("inputs:diffuse_color_constant").has_authored_value()?
            || prim.attribute("inputs:diffuse_texture").has_authored_value()?
        {
            return read_omnipbr(stage, &shader, name);
        }
        if prim.attribute("inputs:base_color_factor").has_authored_value()?
            || prim.attribute("inputs:base_color_texture").has_authored_value()?
        {
            return read_gltf_pbr(stage, &shader, name);
        }
    }
    Ok(Material::neutral(name, "fallback", [0.7, 0.7, 0.7]))
}

/// The shader prim a material terminal connects to, through node graphs.
fn surface_shader(stage: &Stage, material: &sdf::Path, output: &str) -> openusd::Result<Option<sdf::Path>> {
    let attr = material.append_property(output).map_err(openusd::Error::from)?;
    Ok(match follow(stage, &attr, 0)? {
        Source::Output(prim) => Some(prim),
        Source::Value(_) | Source::None => None,
    })
}

fn shader_id(stage: &Stage, shader: &sdf::Path) -> openusd::Result<Option<String>> {
    Ok(crate::extract::token_attr(&stage.prim(shader)?, "info:id"))
}

enum Source {
    /// A shader output, by shader prim.
    Output(sdf::Path),
    Value(Value),
    None,
}

/// Follows an input or terminal through interface connections to a value or a
/// shader output.
fn follow(stage: &Stage, attr_path: &sdf::Path, depth: u32) -> openusd::Result<Source> {
    let attr = stage.attribute(attr_path.clone()).map_err(openusd::Error::from)?;
    if let Some(target) = attr.connections()?.into_iter().next() {
        let name = property_name(&target);
        if name.starts_with("outputs:") {
            let prim = target.prim_path();
            // A node graph output forwards to whatever it connects to.
            if depth < 8 && !is_shader(stage, &prim)? {
                return follow(stage, &target, depth + 1);
            }
            return Ok(Source::Output(prim));
        }
        if name.starts_with("inputs:") && depth < 8 {
            return follow(stage, &target, depth + 1);
        }
        return Ok(Source::None);
    }
    Ok(match attr.get::<Value>()? {
        Some(value) => Source::Value(value),
        None => Source::None,
    })
}

/// The property part of a property path (`outputs:rgb` of `/M/Tex.outputs:rgb`).
fn property_name(path: &sdf::Path) -> &str {
    let s = path.as_str();
    let last = s.rsplit('/').next().unwrap_or(s);
    last.split_once('.').map_or("", |(_, prop)| prop)
}

fn is_shader(stage: &Stage, prim: &sdf::Path) -> openusd::Result<bool> {
    Ok(stage.prim(prim)?.type_name()?.as_deref() == Some("Shader"))
}

fn input(shader: &sdf::Path, name: &str) -> openusd::Result<sdf::Path> {
    shader.append_property(format!("inputs:{name}")).map_err(openusd::Error::from)
}

fn read_preview_surface(stage: &Stage, shader: &sdf::Path, path: String) -> openusd::Result<Material> {
    let mut m = Material::neutral(path, "preview", [0.18, 0.18, 0.18]);
    match follow(stage, &input(shader, "diffuseColor")?, 0)? {
        Source::Value(v) => m.color = color(&v).unwrap_or(m.color),
        Source::Output(tex) => {
            m.color = [1.0; 3];
            m.color_map = uv_texture(stage, &tex)?;
            if let Some(scale) = uv_texture_scale(stage, &tex)? {
                m.color = scale;
            }
        }
        Source::None => {}
    }
    if let Source::Value(v) = follow(stage, &input(shader, "roughness")?, 0)? {
        m.roughness = float(&v).unwrap_or(0.5);
    }
    if let Source::Value(v) = follow(stage, &input(shader, "metallic")?, 0)? {
        m.metallic = float(&v).unwrap_or(0.0);
    }
    if let Source::Value(v) = follow(stage, &input(shader, "opacity")?, 0)? {
        m.opacity = float(&v).unwrap_or(1.0);
    }
    if let Source::Value(v) = follow(stage, &input(shader, "emissiveColor")?, 0)? {
        m.emissive = color(&v).unwrap_or([0.0; 3]);
    }
    if let Source::Output(tex) = follow(stage, &input(shader, "normal")?, 0)? {
        m.normal_map = uv_texture(stage, &tex)?;
    }
    Ok(m)
}

/// The image a `UsdUVTexture` samples and the primvar it samples with.
fn uv_texture(stage: &Stage, shader: &sdf::Path) -> openusd::Result<Option<Texture>> {
    let Source::Value(file) = follow(stage, &input(shader, "file")?, 0)? else {
        return Ok(None);
    };
    let Some(path) = asset(&file) else {
        return Ok(None);
    };
    let mut texture = Texture {
        path,
        uv_set: None,
        scale: [1.0, 1.0],
    };
    if let Source::Output(reader) = follow(stage, &input(shader, "st")?, 0)? {
        // A UsdTransform2d between texture and reader carries the tiling.
        let mut reader = reader;
        if shader_id(stage, &reader)?.as_deref() == Some("UsdTransform2d") {
            if let Source::Value(v) = follow(stage, &input(&reader, "scale")?, 0)? {
                texture.scale = vec2(&v).unwrap_or([1.0, 1.0]);
            }
            match follow(stage, &input(&reader, "in")?, 0)? {
                Source::Output(next) => reader = next,
                _ => return Ok(Some(texture)),
            }
        }
        if let Source::Value(v) = follow(stage, &input(&reader, "varname")?, 0)? {
            texture.uv_set = string(&v);
        }
    }
    Ok(Some(texture))
}

/// A `UsdUVTexture` `scale` input tints the sampled color.
fn uv_texture_scale(stage: &Stage, shader: &sdf::Path) -> openusd::Result<Option<[f32; 3]>> {
    Ok(match follow(stage, &input(shader, "scale")?, 0)? {
        Source::Value(Value::Vec4f(v)) => Some([v.x, v.y, v.z]),
        _ => None,
    })
}

fn read_omnipbr(stage: &Stage, shader: &sdf::Path, path: String) -> openusd::Result<Material> {
    let mut m = Material::neutral(path, "omnipbr", [0.2, 0.2, 0.2]);
    let value = |name: &str| -> openusd::Result<Option<Value>> {
        Ok(match follow(stage, &input(shader, name)?, 0)? {
            Source::Value(v) => Some(v),
            _ => None,
        })
    };
    if let Some(c) = value("diffuse_color_constant")?.as_ref().and_then(color) {
        m.color = c;
    }
    if let Some(r) = value("reflection_roughness_constant")?.as_ref().and_then(float) {
        m.roughness = r;
    }
    if let Some(v) = value("metallic_constant")?.as_ref().and_then(float) {
        m.metallic = v;
    }
    let scale = value("texture_scale")?.as_ref().and_then(vec2).unwrap_or([1.0, 1.0]);
    if let Some(file) = value("diffuse_texture")?.as_ref().and_then(asset) {
        m.color_map = Some(Texture {
            path: file,
            uv_set: None,
            scale,
        });
        // OmniPBR multiplies the texture by diffuse_tint, not the constant.
        m.color = value("diffuse_tint")?.as_ref().and_then(color).unwrap_or([1.0; 3]);
    }
    if let Some(file) = value("normalmap_texture")?.as_ref().and_then(asset) {
        m.normal_map = Some(Texture {
            path: file,
            uv_set: None,
            scale,
        });
    }
    if value("enable_emission")?.as_ref().and_then(boolean) == Some(true) {
        let c = value("emissive_color")?.as_ref().and_then(color).unwrap_or([1.0; 3]);
        let k = value("emissive_intensity")?.as_ref().and_then(float).unwrap_or(0.0);
        // OmniPBR intensities are in nits-like units; squash into [0, 1].
        let k = (k / 1000.0).min(1.0);
        m.emissive = [c[0] * k, c[1] * k, c[2] * k];
    }
    if value("enable_opacity")?.as_ref().and_then(boolean) == Some(true) {
        m.opacity = value("opacity_constant")?.as_ref().and_then(float).unwrap_or(1.0);
    }
    Ok(m)
}

fn read_gltf_pbr(stage: &Stage, shader: &sdf::Path, path: String) -> openusd::Result<Material> {
    let mut m = Material::neutral(path, "gltf-pbr", [1.0, 1.0, 1.0]);
    let value = |name: &str| -> openusd::Result<Option<Value>> {
        Ok(match follow(stage, &input(shader, name)?, 0)? {
            Source::Value(v) => Some(v),
            _ => None,
        })
    };
    if let Some(v) = value("base_color_factor")? {
        if let Some(c) = color(&v) {
            m.color = c;
        }
        if let Value::Vec4f(c) = v {
            m.opacity = c.w;
        }
    }
    m.roughness = value("roughness_factor")?.as_ref().and_then(float).unwrap_or(1.0);
    m.metallic = value("metallic_factor")?.as_ref().and_then(float).unwrap_or(1.0);
    m.color_map = gltf_texture(stage, shader, "base_color_texture")?;
    m.normal_map = gltf_texture(stage, shader, "normal_texture")?;
    Ok(m)
}

/// A glTF `pbr.mdl` texture input: an asset value, or a connection to a
/// `gltf_texture_lookup` shader carrying the file and its tiling.
fn gltf_texture(stage: &Stage, shader: &sdf::Path, name: &str) -> openusd::Result<Option<Texture>> {
    let (file, scale) = match follow(stage, &input(shader, name)?, 0)? {
        Source::Value(v) => (asset(&v), None),
        Source::Output(lookup) => {
            let file = match follow(stage, &input(&lookup, "texture")?, 0)? {
                Source::Value(v) => asset(&v),
                _ => None,
            };
            let scale = match follow(stage, &input(&lookup, "scale")?, 0)? {
                Source::Value(v) => vec2(&v),
                _ => None,
            };
            (file, scale)
        }
        Source::None => (None, None),
    };
    Ok(file.map(|path| Texture {
        path,
        uv_set: None,
        scale: scale.unwrap_or([1.0, 1.0]),
    }))
}

fn asset(value: &Value) -> Option<String> {
    match value {
        Value::AssetPath(a) if !a.is_empty() => Some(match a.resolved_path() {
            Some(resolved) if !resolved.is_empty() => resolved.to_owned(),
            _ => a.asset_path().to_owned(),
        }),
        _ => None,
    }
}

fn color(value: &Value) -> Option<[f32; 3]> {
    match value {
        Value::Vec3f(c) => Some([c.x, c.y, c.z]),
        Value::Vec3d(c) => Some([c.x as f32, c.y as f32, c.z as f32]),
        Value::Vec4f(c) => Some([c.x, c.y, c.z]),
        Value::Vec4d(c) => Some([c.x as f32, c.y as f32, c.z as f32]),
        _ => None,
    }
}

fn vec2(value: &Value) -> Option<[f32; 2]> {
    match value {
        Value::Vec2f(v) => Some([v.x, v.y]),
        Value::Vec2d(v) => Some([v.x as f32, v.y as f32]),
        _ => None,
    }
}

fn float(value: &Value) -> Option<f32> {
    match value {
        Value::Float(v) => Some(*v),
        Value::Double(v) => Some(*v as f32),
        Value::Half(v) => Some(v.to_f32()),
        _ => None,
    }
}

fn boolean(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(v) => Some(*v),
        Value::Int(v) => Some(*v != 0),
        _ => None,
    }
}

fn string(value: &Value) -> Option<String> {
    match value {
        Value::Token(t) => Some(t.as_str().to_owned()),
        Value::String(s) => Some(s.clone()),
        _ => None,
    }
}
