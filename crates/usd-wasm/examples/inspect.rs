//! Composes USD files from disk through the same in-memory path the browser
//! uses and prints what a viewer would draw.
//!
//! usage: cargo run --profile native --example inspect -- <root.usd>...

use std::time::Instant;

use usd_wasm::{Composed, Loader};

fn main() {
    for root in std::env::args().skip(1) {
        let root = std::fs::canonicalize(&root).expect("root path").to_string_lossy().into_owned();
        if let Err(e) = inspect(&root) {
            println!("{root}: error: {e}");
        }
    }
}

fn inspect(root: &str) -> Result<(), Box<dyn std::error::Error>> {
    let t0 = Instant::now();
    let mut loader = Loader::new();
    let mut queue = vec![root.to_owned()];
    let (mut layers, mut bytes, mut variant_only) = (0, 0usize, 0);
    let mut rounds = 0;
    let scene = loop {
        while let Some(path) = queue.pop() {
            if loader.has(&path) {
                continue;
            }
            let Ok(data) = std::fs::read(&path) else {
                println!("  missing on disk: {path}");
                loader.mark_unavailable(&path);
                continue;
            };
            layers += 1;
            bytes += data.len();
            for dep in loader.add_layer(&path, data)? {
                if !dep.arc || loader.has(&dep.path) {
                    continue;
                }
                if dep.in_variant {
                    variant_only += 1;
                    continue;
                }
                queue.push(dep.path);
            }
        }
        rounds += 1;
        match loader.compose(root)? {
            Composed::Scene(scene) => break scene,
            Composed::Missing(missing) => queue.extend(missing),
        }
    };
    let elapsed = t0.elapsed();
    let s = &scene.stats;
    let verts: usize = scene.geometries.iter().map(|g| g.positions.len() / 3).sum();
    println!(
        "{root}\n  layers {layers} ({:.1} MB), compose rounds {rounds}, variant-only arcs deferred {variant_only}\n  prims {} meshes {} (unique geometries {}) tris {} verts {} | skipped invisible {} purpose {} empty {}\n  upAxis {} metersPerUnit {} materials {} | {:.0} ms",
        bytes as f64 / 1e6,
        s.prims,
        s.meshes,
        scene.geometries.len(),
        s.triangles,
        verts,
        s.skipped_invisible,
        s.skipped_purpose,
        s.skipped_empty,
        scene.up_axis,
        scene.meters_per_unit,
        scene.materials.len(),
        elapsed.as_secs_f64() * 1000.0
    );
    for m in &scene.materials {
        println!(
            "    material {} [{}] color {:?} map {:?}",
            m.path,
            m.kind,
            m.color,
            m.color_map.as_ref().map(|t| &t.path)
        );
    }
    for (path, why) in &s.skipped {
        println!("    skipped ({why}) {path}");
    }
    if std::env::var("LIST").is_ok() {
        for i in &scene.instances {
            let g = &scene.geometries[i.geometry as usize];
            println!("    mesh {} tris {} mats {:?}", i.path, g.indices.len() / 3, i.materials);
        }
    }
    Ok(())
}
