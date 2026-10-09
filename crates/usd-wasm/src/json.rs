//! A tiny JSON writer for scene metadata (keeps serde out of the WASM binary).

use std::fmt::Write;

use crate::Scene;
use crate::material::Texture;

pub fn scene_meta(scene: &Scene) -> String {
    let mut o = String::with_capacity(1024 + scene.instances.len() * 256);
    o.push('{');
    o.push_str("\"upAxis\":");
    string(&mut o, &scene.up_axis);
    let _ = write!(o, ",\"metersPerUnit\":{}", num(scene.meters_per_unit));
    let s = &scene.stats;
    let _ = write!(
        o,
        ",\"stats\":{{\"prims\":{},\"meshes\":{},\"triangles\":{},\"skippedInvisible\":{},\"skippedPurpose\":{},\"skippedEmpty\":{}}}",
        s.prims, s.meshes, s.triangles, s.skipped_invisible, s.skipped_purpose, s.skipped_empty
    );

    o.push_str(",\"warnings\":[");
    for (i, w) in scene.warnings.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        string(&mut o, w);
    }
    o.push(']');
    o.push_str(",\"geometries\":[");
    for (i, g) in scene.geometries.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        let _ = write!(
            o,
            "{{\"vertices\":{},\"points\":{},\"hasUvs\":{},\"groups\":[",
            g.positions.len() / 3,
            g.points,
            !g.uvs.is_empty()
        );
        for (j, group) in g.groups.iter().enumerate() {
            if j > 0 {
                o.push(',');
            }
            let _ = write!(o, "[{},{}", group.start, group.count);
            if let Some(subset) = &group.subset {
                o.push(',');
                string(&mut o, subset);
            }
            o.push(']');
        }
        o.push_str("]}");
    }

    o.push_str("],\"instances\":[");
    for (i, inst) in scene.instances.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"path\":");
        string(&mut o, &inst.path);
        let _ = write!(o, ",\"geometry\":{},\"doubleSided\":{},\"matrix\":[", inst.geometry, inst.double_sided);
        for (j, v) in inst.matrix.iter().enumerate() {
            if j > 0 {
                o.push(',');
            }
            o.push_str(&num(*v));
        }
        o.push_str("],\"materials\":[");
        for (j, m) in inst.materials.iter().enumerate() {
            if j > 0 {
                o.push(',');
            }
            let _ = write!(o, "{m}");
        }
        o.push_str("]}");
    }

    o.push_str("],\"materials\":[");
    for (i, m) in scene.materials.iter().enumerate() {
        if i > 0 {
            o.push(',');
        }
        o.push_str("{\"path\":");
        string(&mut o, &m.path);
        o.push_str(",\"kind\":");
        string(&mut o, m.kind);
        let _ = write!(
            o,
            ",\"color\":[{},{},{}],\"opacity\":{},\"roughness\":{},\"metallic\":{},\"emissive\":[{},{},{}]",
            num(m.color[0].into()),
            num(m.color[1].into()),
            num(m.color[2].into()),
            num(m.opacity.into()),
            num(m.roughness.into()),
            num(m.metallic.into()),
            num(m.emissive[0].into()),
            num(m.emissive[1].into()),
            num(m.emissive[2].into())
        );
        texture(&mut o, "colorMap", m.color_map.as_ref());
        texture(&mut o, "normalMap", m.normal_map.as_ref());
        o.push('}');
    }
    o.push_str("]}");
    o
}

fn texture(o: &mut String, key: &str, t: Option<&Texture>) {
    let Some(t) = t else {
        return;
    };
    let _ = write!(o, ",\"{key}\":{{\"path\":");
    string(o, &t.path);
    for (key, wrap) in ["wrapS", "wrapT"].into_iter().zip(&t.wrap) {
        if let Some(wrap) = wrap {
            let _ = write!(o, ",\"{key}\":");
            string(o, wrap);
        }
    }
    if let Some(uv) = &t.uv_set {
        o.push_str(",\"uvSet\":");
        string(o, uv);
    }
    let _ = write!(
        o,
        ",\"scale\":[{},{}],\"rotation\":{},\"translation\":[{},{}]}}",
        num(t.scale[0].into()),
        num(t.scale[1].into()),
        num(t.rotation.into()),
        num(t.translation[0].into()),
        num(t.translation[1].into())
    );
}

fn num(v: f64) -> String {
    if v.is_finite() { format!("{v}") } else { "0".to_owned() }
}

fn string(o: &mut String, s: &str) {
    o.push('"');
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
}
