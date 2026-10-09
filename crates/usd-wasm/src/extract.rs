//! Walks a composed stage and flattens what a viewer draws: triangle meshes
//! with world transforms and simple PBR materials.

use std::collections::{HashMap, HashSet};

use openusd::gf::Matrix4d;
use openusd::sdf::{self, Value};
use openusd::usd::{self, PrimPredicate, Stage};
use openusd_schemas::geom::XformCache;
use openusd_schemas::shade::MaterialBindingAPI;

use crate::material::{self, Material};

/// Everything a renderer needs from a stage, with no references back into it.
#[derive(Default)]
pub struct Scene {
    pub up_axis: String,
    pub meters_per_unit: f64,
    /// Triangle data, shared by every instance that draws it.
    pub geometries: Vec<Geometry>,
    pub instances: Vec<Instance>,
    pub materials: Vec<Material>,
    pub stats: Stats,
}

#[derive(Default, Debug)]
pub struct Stats {
    pub prims: usize,
    pub meshes: usize,
    pub skipped_invisible: usize,
    pub skipped_purpose: usize,
    pub skipped_empty: usize,
    pub triangles: usize,
    /// Meshes left out, with why: `invisible`, `purpose` or `empty`.
    pub skipped: Vec<(String, &'static str)>,
}

pub struct Geometry {
    pub source: String,
    /// Authored point count (before per-corner splitting).
    pub points: usize,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    /// Empty when the mesh has no texture coordinates.
    pub uvs: Vec<f32>,
    pub indices: Vec<u32>,
    /// Index ranges, one per material subset; a single range without subsets.
    pub groups: Vec<Group>,
    /// Local bounding box of `positions`: min, then max.
    pub bounds: [[f32; 3]; 2],
}

pub struct Group {
    pub start: u32,
    pub count: u32,
    /// The `GeomSubset` child (by name) whose binding this range takes.
    pub subset: Option<String>,
}

pub struct Instance {
    pub path: String,
    pub geometry: u32,
    /// Local-to-world, row-major with row vectors (USD); the same 16 numbers
    /// are a column-major matrix for three.js.
    pub matrix: [f64; 16],
    /// One material index per geometry group.
    pub materials: Vec<u32>,
    pub double_sided: bool,
}

/// Inherited imageable state along the traversal.
#[derive(Clone, Copy, Default)]
struct Inherited {
    invisible: bool,
    /// The nearest authored purpose is `guide` or `proxy`.
    hidden_purpose: bool,
    /// Index into the prototypes: under a PointInstancer prototype, which is
    /// drawn only at that instancer's placements.
    prototype: Option<u32>,
}

/// A PointInstancer prototype and where instancers place it: each instance's
/// index and its prototype-to-world transform.
struct Prototype {
    root: sdf::Path,
    placements: Vec<(usize, Matrix4d)>,
}

pub fn extract(stage: &Stage) -> openusd::Result<Scene> {
    let mut scene = Scene {
        up_axis: token_metadata(stage, "upAxis").unwrap_or_else(|| "Y".to_owned()),
        meters_per_unit: match stage.stage_metadata("metersPerUnit")? {
            Some(Value::Double(v)) => v,
            Some(Value::Float(v)) => v as f64,
            _ => 0.01,
        },
        ..Scene::default()
    };

    let mut paths = Vec::new();
    stage.traverse(PrimPredicate::DEFAULT_PROXIES, |path| paths.push(path.clone()))?;
    scene.stats.prims = paths.len();

    let mut state: HashMap<sdf::Path, Inherited> = HashMap::with_capacity(paths.len());
    let mut xforms = XformCache::new(None);
    let mut geometry_by_source: HashMap<String, u32> = HashMap::new();
    let mut materials = material::Cache::default();

    let mut prototypes: Vec<Prototype> = Vec::new();
    for path in &paths {
        let prim = stage.prim(path)?;
        if prim.type_name()?.as_deref() == Some("PointInstancer") {
            let world = xforms.local_to_world_transform(&prim).unwrap_or(Matrix4d::IDENTITY);
            add_placements(&prim, world, &mut prototypes)?;
        }
    }

    for path in paths {
        let prim = stage.prim(&path)?;
        let parent = path
            .parent()
            .and_then(|p| state.get(&p).copied())
            .unwrap_or_default();
        let mut own = parent;
        if !own.invisible && token_attr(&prim, "visibility").as_deref() == Some("invisible") {
            own.invisible = true;
        }
        // Only an authored purpose overrides the inherited one; the schema
        // fallback (`default`) on every prim must not.
        if prim.attribute("purpose").has_authored_value()?
            && let Some(purpose) = token_attr(&prim, "purpose")
        {
            own.hidden_purpose = purpose == "guide" || purpose == "proxy";
        }
        if let Some(index) = prototypes.iter().position(|p| p.root == path) {
            own.prototype = Some(index as u32);
        }
        state.insert(path.clone(), own);

        if prim.type_name()?.as_deref() != Some("Mesh") {
            continue;
        }
        if own.invisible {
            scene.stats.skipped_invisible += 1;
            scene.stats.skipped.push((path.as_str().to_owned(), "invisible"));
            continue;
        }
        if own.hidden_purpose {
            scene.stats.skipped_purpose += 1;
            scene.stats.skipped.push((path.as_str().to_owned(), "purpose"));
            continue;
        }

        // Instance proxies share their prototype's data: read it once.
        let source = match prim.prim_in_prototype()? {
            Some(proto) => proto,
            None => prim.clone(),
        };
        let key = source.path().as_str().to_owned();
        let geometry = match geometry_by_source.get(&key) {
            Some(&index) => Some(index),
            None => match read_mesh(&source)? {
                Some(geometry) => {
                    let index = scene.geometries.len() as u32;
                    scene.geometries.push(geometry);
                    geometry_by_source.insert(key, index);
                    Some(index)
                }
                None => None,
            },
        };
        let Some(geometry) = geometry else {
            scene.stats.skipped_empty += 1;
            scene.stats.skipped.push((path.as_str().to_owned(), "empty"));
            continue;
        };

        let groups = &scene.geometries[geometry as usize].groups;
        let mesh_material = bound_material(stage, &path, &mut materials, &mut scene.materials, &prim)?;
        let mut instance_materials = Vec::with_capacity(groups.len());
        for group in groups {
            let index = match &group.subset {
                Some(name) => {
                    let subset_path = path.append_path(name.as_str()).map_err(openusd::Error::from)?;
                    let subset = stage.prim(&subset_path)?;
                    match MaterialBindingAPI::from_prim_unchecked(subset).compute_bound_material("preview")? {
                        Some(mat) => materials.get(stage, &mat, &mut scene.materials)?,
                        None => mesh_material,
                    }
                }
                None => mesh_material,
            };
            instance_materials.push(index);
        }

        let placed = match own.prototype {
            None => vec![(
                path.as_str().to_owned(),
                xforms.local_to_world_transform(&prim).unwrap_or(Matrix4d::IDENTITY),
            )],
            Some(index) => {
                let prototype = &prototypes[index as usize];
                let above_root = stage.prim(prototype.root.parent().unwrap_or_else(sdf::Path::abs_root))?;
                let (to_root, _) = xforms
                    .compute_relative_transform(&prim, &above_root)
                    .unwrap_or((Matrix4d::IDENTITY, false));
                prototype
                    .placements
                    .iter()
                    .map(|&(i, placement)| (format!("{}[{i}]", path.as_str()), to_root * placement))
                    .collect()
            }
        };
        let double_sided = matches!(prim.attribute("doubleSided").get::<bool>(), Ok(Some(true)));
        let triangles = scene.geometries[geometry as usize].indices.len() / 3;
        for (path, matrix) in placed {
            scene.stats.meshes += 1;
            scene.stats.triangles += triangles;
            scene.instances.push(Instance {
                path,
                geometry,
                matrix: matrix.0,
                materials: instance_materials.clone(),
                double_sided,
            });
        }
    }
    Ok(scene)
}

/// Records where a PointInstancer places each of its prototypes:
/// `scale * orientation * translate(position)` under the instancer's own
/// transform, leaving out `invisibleIds` and `inactiveIds`.
fn add_placements(prim: &usd::Prim, world: Matrix4d, out: &mut Vec<Prototype>) -> openusd::Result<()> {
    let targets = prim.relationship("prototypes").targets()?;
    let Some(proto_indices) = ints(prim.attribute("protoIndices").get::<Value>()?) else {
        return Ok(());
    };
    let Some(positions) = prim.attribute("positions").get::<Value>()?.as_ref().and_then(vec3s) else {
        return Ok(());
    };
    let orientations: Vec<[f64; 4]> = match prim.attribute("orientations").get::<Value>()? {
        Some(Value::QuathVec(q)) => q
            .iter()
            .map(|q| [q.w, q.x, q.y, q.z].map(|v| v.to_f32() as f64))
            .collect(),
        _ => match prim.attribute("orientationsf").get::<Value>()? {
            Some(Value::QuatfVec(q)) => q.iter().map(|&q| q.into()).collect(),
            _ => Vec::new(),
        },
    };
    let scales = prim
        .attribute("scales")
        .get::<Value>()?
        .as_ref()
        .and_then(vec3s)
        .unwrap_or_default();
    let ids = match prim.attribute("ids").get::<Value>()? {
        Some(Value::Int64Vec(ids)) => ids,
        _ => Vec::new(),
    };
    let mut hidden: HashSet<i64> = match prim.attribute("invisibleIds").get::<Value>()? {
        Some(Value::Int64Vec(ids)) => ids.into_iter().collect(),
        _ => HashSet::new(),
    };
    if let Some(Value::Int64ListOp(op)) = prim.get_metadata::<Value>("inactiveIds")? {
        hidden.extend(op.compose_over(&[]));
    }

    for (i, &proto) in proto_indices.iter().enumerate() {
        let (Some(root), Some(&position)) = (targets.get(proto as usize), positions.get(i)) else {
            continue;
        };
        if hidden.contains(&ids.get(i).copied().unwrap_or(i as i64)) {
            continue;
        }
        let orientation = orientations.get(i).copied().unwrap_or([1.0, 0.0, 0.0, 0.0]);
        let scale = scales.get(i).copied().unwrap_or([1.0; 3]);
        let placement = Matrix4d::scale(scale.map(f64::from))
            * Matrix4d::from_quat(orientation)
            * Matrix4d::translation(position.map(f64::from))
            * world;
        match out.iter_mut().find(|p| &p.root == root) {
            Some(prototype) => prototype.placements.push((i, placement)),
            None => out.push(Prototype {
                root: root.clone(),
                placements: vec![(i, placement)],
            }),
        }
    }
    Ok(())
}

/// The material bound to `path` for preview rendering, or a fallback built from
/// `displayColor` (or neutral grey) so geometry always shows.
fn bound_material(
    stage: &Stage,
    path: &sdf::Path,
    cache: &mut material::Cache,
    out: &mut Vec<Material>,
    prim: &usd::Prim,
) -> openusd::Result<u32> {
    let binding = MaterialBindingAPI::from_prim_unchecked(prim.clone()).compute_bound_material("preview")?;
    if let Some(mat) = binding {
        let index = cache.get(stage, &mat, out)?;
        // Per-mesh colors read through a primvar reader: use the first value
        // (vertex colors are not supported yet).
        if let Some(name) = out[index as usize].color_primvar.clone() {
            let value = prim.attribute(format!("primvars:{name}").as_str()).get::<Value>()?;
            if let Some(color) = value.as_ref().and_then(first_color) {
                return Ok(cache.with_primvar_color(index, color, out));
            }
        }
        return Ok(index);
    }
    let color = match prim.attribute("primvars:displayColor").get::<Value>()? {
        Some(value) => first_color(&value),
        None => None,
    };
    let _ = path;
    Ok(cache.display_color(color, out))
}

fn first_color(value: &Value) -> Option<[f32; 3]> {
    match value {
        Value::Vec3fVec(v) => v.first().map(|c| [c.x, c.y, c.z]),
        Value::Vec3f(c) => Some([c.x, c.y, c.z]),
        Value::Vec3dVec(v) => v.first().map(|c| [c.x as f32, c.y as f32, c.z as f32]),
        _ => None,
    }
}

pub(crate) fn token_attr(prim: &usd::Prim, name: &str) -> Option<String> {
    match prim.attribute(name).get::<Value>() {
        Ok(Some(Value::Token(t))) => Some(t.as_str().to_owned()),
        Ok(Some(Value::String(s))) => Some(s),
        _ => None,
    }
}

fn token_metadata(stage: &Stage, key: &str) -> Option<String> {
    match stage.stage_metadata(key) {
        Ok(Some(Value::Token(t))) => Some(t.as_str().to_owned()),
        Ok(Some(Value::String(s))) => Some(s),
        _ => None,
    }
}

/// How a primvar's values map onto the mesh.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Interp {
    Constant,
    Uniform,
    Vertex,
    FaceVarying,
}

struct Primvar<T> {
    values: Vec<T>,
    interp: Interp,
}

fn read_primvar<T>(
    prim: &usd::Prim,
    name: &str,
    default_interp: Interp,
    convert: fn(&Value) -> Option<Vec<T>>,
) -> openusd::Result<Option<Primvar<T>>>
where
    T: Copy,
{
    let attr = prim.attribute(name);
    let Some(value) = attr.get::<Value>()? else {
        return Ok(None);
    };
    let Some(mut values) = convert(&value) else {
        return Ok(None);
    };
    let interp = match attr.get_metadata::<Value>("interpolation")? {
        Some(Value::Token(t)) => match t.as_str() {
            "constant" => Interp::Constant,
            "uniform" => Interp::Uniform,
            "faceVarying" => Interp::FaceVarying,
            _ => Interp::Vertex,
        },
        _ => default_interp,
    };
    let indices_attr = prim.attribute(format!("{name}:indices").as_str());
    if let Some(Value::IntVec(indices)) = indices_attr.get::<Value>()? {
        let mut flat = Vec::with_capacity(indices.len());
        for i in indices {
            match values.get(i as usize) {
                Some(&v) => flat.push(v),
                None => return Ok(None),
            }
        }
        values = flat;
    }
    Ok(Some(Primvar { values, interp }))
}

fn vec3s(value: &Value) -> Option<Vec<[f32; 3]>> {
    match value {
        Value::Vec3fVec(v) => Some(v.iter().map(|p| [p.x, p.y, p.z]).collect()),
        Value::Vec3dVec(v) => Some(v.iter().map(|p| [p.x as f32, p.y as f32, p.z as f32]).collect()),
        Value::Vec3hVec(v) => Some(v.iter().map(|p| [p.x.to_f32(), p.y.to_f32(), p.z.to_f32()]).collect()),
        _ => None,
    }
}

fn vec2s(value: &Value) -> Option<Vec<[f32; 2]>> {
    match value {
        Value::Vec2fVec(v) => Some(v.iter().map(|p| [p.x, p.y]).collect()),
        Value::Vec2dVec(v) => Some(v.iter().map(|p| [p.x as f32, p.y as f32]).collect()),
        Value::Vec2hVec(v) => Some(v.iter().map(|p| [p.x.to_f32(), p.y.to_f32()]).collect()),
        _ => None,
    }
}

fn ints(value: Option<Value>) -> Option<Vec<i32>> {
    match value {
        Some(Value::IntVec(v)) => Some(v),
        _ => None,
    }
}

const UV_NAMES: [&str; 6] = ["primvars:st", "primvars:st0", "primvars:UVMap", "primvars:uv", "primvars:map1", "primvars:st_0"];

fn read_mesh(prim: &usd::Prim) -> openusd::Result<Option<Geometry>> {
    let Some(points) = prim.attribute("points").get::<Value>()?.as_ref().and_then(vec3s) else {
        return Ok(None);
    };
    let Some(counts) = ints(prim.attribute("faceVertexCounts").get::<Value>()?) else {
        return Ok(None);
    };
    let Some(face_indices) = ints(prim.attribute("faceVertexIndices").get::<Value>()?) else {
        return Ok(None);
    };
    if points.is_empty() || counts.is_empty() {
        return Ok(None);
    }
    let corners: usize = counts.iter().map(|&c| c.max(0) as usize).sum();
    if corners != face_indices.len() || face_indices.iter().any(|&i| i < 0 || i as usize >= points.len()) {
        return Ok(None);
    }
    let left_handed = token_attr(prim, "orientation").as_deref() == Some("leftHanded");

    // Primvars fall back to constant interpolation; the `normals` attribute to vertex.
    let normals = match read_primvar(prim, "primvars:normals", Interp::Constant, vec3s)? {
        Some(n) => Some(n),
        None => read_primvar(prim, "normals", Interp::Vertex, vec3s)?,
    };
    let mut uvs = None;
    for name in UV_NAMES {
        if let Some(uv) = read_primvar(prim, name, Interp::Constant, vec2s)? {
            uvs = Some(uv);
            break;
        }
    }
    let normals = normals.filter(|n| fits(n.interp, n.values.len(), points.len(), counts.len(), corners));
    let uvs = uvs.filter(|uv| fits(uv.interp, uv.values.len(), points.len(), counts.len(), corners));

    // A polygonal mesh with no normals is drawn faceted; a subdivision surface
    // (the schema fallback) gets smooth normals as its approximation.
    let faceted = normals.is_none() && token_attr(prim, "subdivisionScheme").as_deref() == Some("none");
    // Per-point layout when every attribute is per point; otherwise one vertex
    // per face corner, which faceVarying and uniform data need.
    let per_corner = faceted
        || [normals.as_ref().map(|n| n.interp), uvs.as_ref().map(|u| u.interp)]
            .into_iter()
            .flatten()
            .any(|i| matches!(i, Interp::FaceVarying | Interp::Uniform));

    let vertex_count = if per_corner { corners } else { points.len() };
    // Maps an output vertex to (point index, face index, corner index).
    let mut point_of = Vec::with_capacity(vertex_count);
    let mut face_of = Vec::with_capacity(if per_corner { corners } else { 0 });
    if per_corner {
        for (face, &count) in counts.iter().enumerate() {
            for _ in 0..count.max(0) {
                face_of.push(face as u32);
            }
        }
        point_of.extend(face_indices.iter().map(|&i| i as u32));
    } else {
        point_of.extend(0..points.len() as u32);
    }

    let mut normals = match normals {
        Some(n) => expand3(&n, &point_of, &face_of, per_corner),
        None if faceted => face_normals(&points, &counts, &face_indices, &face_of, left_handed),
        None => smooth_normals(&points, &counts, &face_indices, &point_of, left_handed),
    };
    let mut uvs = match uvs {
        Some(uv) => expand2(&uv, &point_of, &face_of, per_corner),
        None => Vec::new(),
    };

    // Corners that agree on point, normal and UV become one vertex again.
    let (positions, remap) = if per_corner {
        let welded = weld(&point_of, &points, &normals, &uvs);
        normals = welded.normals;
        uvs = welded.uvs;
        (welded.positions, Some(welded.remap))
    } else {
        (points.as_flattened().to_vec(), None)
    };

    // Triangle fans, ordered by subset so each subset is one contiguous range.
    let subsets = read_subsets(prim, counts.len())?;
    let mut hole = vec![false; counts.len()];
    for i in ints(prim.attribute("holeIndices").get::<Value>()?).unwrap_or_default() {
        if let Some(h) = hole.get_mut(i as usize) {
            *h = true;
        }
    }
    let mut face_start = Vec::with_capacity(counts.len());
    let mut offset = 0u32;
    for &count in &counts {
        face_start.push(offset);
        offset += count.max(0) as u32;
    }
    let vertex = |corner: u32| -> u32 {
        match &remap {
            Some(remap) => remap[corner as usize],
            None => face_indices[corner as usize] as u32,
        }
    };
    let mut indices = Vec::with_capacity((corners.saturating_sub(2 * counts.len())) * 3);
    let mut groups = Vec::new();
    let mut emit = |faces: &mut dyn Iterator<Item = usize>, subset: Option<String>, indices: &mut Vec<u32>| {
        let start = indices.len() as u32;
        for face in faces {
            let n = counts[face];
            if n < 3 || hole[face] {
                continue;
            }
            let base = face_start[face];
            for k in 1..(n as u32 - 1) {
                let (a, b, c) = (vertex(base), vertex(base + k), vertex(base + k + 1));
                if left_handed {
                    indices.extend_from_slice(&[a, c, b]);
                } else {
                    indices.extend_from_slice(&[a, b, c]);
                }
            }
        }
        let count = indices.len() as u32 - start;
        if count > 0 {
            groups.push(Group { start, count, subset });
        }
    };
    if subsets.is_empty() {
        emit(&mut (0..counts.len()), None, &mut indices);
    } else {
        let mut covered = vec![false; counts.len()];
        for (name, faces) in &subsets {
            for &f in faces {
                covered[f] = true;
            }
            emit(&mut faces.iter().copied(), Some(name.clone()), &mut indices);
        }
        emit(&mut (0..counts.len()).filter(|&f| !covered[f]), None, &mut indices);
    }
    if indices.is_empty() {
        return Ok(None);
    }
    let (mut min, mut max) = ([f32::INFINITY; 3], [f32::NEG_INFINITY; 3]);
    for p in positions.chunks_exact(3) {
        for k in 0..3 {
            min[k] = min[k].min(p[k]);
            max[k] = max[k].max(p[k]);
        }
    }

    Ok(Some(Geometry {
        source: prim.path().as_str().to_owned(),
        points: points.len(),
        positions,
        normals,
        uvs,
        indices,
        groups,
        bounds: [min, max],
    }))
}

struct Welded {
    remap: Vec<u32>,
    positions: Vec<f32>,
    normals: Vec<f32>,
    uvs: Vec<f32>,
}

/// Merges per-corner vertices that share a point and have bit-identical
/// normal and UV. Candidates are chained per point, so the search stays local.
fn weld(point_of: &[u32], points: &[[f32; 3]], normals: &[f32], uvs: &[f32]) -> Welded {
    const NONE: u32 = u32::MAX;
    let has_uv = !uvs.is_empty();
    let mut head = vec![NONE; points.len()];
    let mut next: Vec<u32> = Vec::new();
    let mut first_corner: Vec<u32> = Vec::new();
    let mut remap = Vec::with_capacity(point_of.len());
    let same = |a: usize, b: usize| {
        normals[a * 3..a * 3 + 3].iter().zip(&normals[b * 3..b * 3 + 3]).all(|(x, y)| x.to_bits() == y.to_bits())
            && (!has_uv || uvs[a * 2..a * 2 + 2].iter().zip(&uvs[b * 2..b * 2 + 2]).all(|(x, y)| x.to_bits() == y.to_bits()))
    };
    for (corner, &point) in point_of.iter().enumerate() {
        let mut candidate = head[point as usize];
        while candidate != NONE && !same(first_corner[candidate as usize] as usize, corner) {
            candidate = next[candidate as usize];
        }
        if candidate == NONE {
            candidate = first_corner.len() as u32;
            first_corner.push(corner as u32);
            next.push(head[point as usize]);
            head[point as usize] = candidate;
        }
        remap.push(candidate);
    }
    let gather = |src: &[f32], width: usize| -> Vec<f32> {
        let mut out = Vec::with_capacity(first_corner.len() * width);
        for &c in &first_corner {
            out.extend_from_slice(&src[c as usize * width..c as usize * width + width]);
        }
        out
    };
    Welded {
        positions: first_corner.iter().flat_map(|&c| points[point_of[c as usize] as usize]).collect(),
        normals: gather(normals, 3),
        uvs: if has_uv { gather(uvs, 2) } else { Vec::new() },
        remap,
    }
}

fn fits(interp: Interp, len: usize, points: usize, faces: usize, corners: usize) -> bool {
    match interp {
        Interp::Constant => len >= 1,
        Interp::Uniform => len >= faces,
        Interp::Vertex => len >= points,
        Interp::FaceVarying => len >= corners,
    }
}

/// Picks the primvar value for output vertex `v`.
fn pick(interp: Interp, v: usize, point_of: &[u32], face_of: &[u32], per_corner: bool) -> usize {
    match interp {
        Interp::Constant => 0,
        Interp::Vertex => point_of[v] as usize,
        Interp::Uniform => face_of[v] as usize,
        // Only reachable in the per-corner layout, where vertex == corner.
        Interp::FaceVarying => {
            debug_assert!(per_corner);
            v
        }
    }
}

fn expand3(pv: &Primvar<[f32; 3]>, point_of: &[u32], face_of: &[u32], per_corner: bool) -> Vec<f32> {
    let mut out = Vec::with_capacity(point_of.len() * 3);
    for v in 0..point_of.len() {
        out.extend_from_slice(&pv.values[pick(pv.interp, v, point_of, face_of, per_corner)]);
    }
    out
}

fn expand2(pv: &Primvar<[f32; 2]>, point_of: &[u32], face_of: &[u32], per_corner: bool) -> Vec<f32> {
    let mut out = Vec::with_capacity(point_of.len() * 2);
    for v in 0..point_of.len() {
        out.extend_from_slice(&pv.values[pick(pv.interp, v, point_of, face_of, per_corner)]);
    }
    out
}

/// Area-weighted smooth normals per point, the shading Hydra gives meshes
/// that author none.
fn smooth_normals(
    points: &[[f32; 3]],
    counts: &[i32],
    face_indices: &[i32],
    point_of: &[u32],
    left_handed: bool,
) -> Vec<f32> {
    let mut acc = vec![[0f32; 3]; points.len()];
    let mut corner = 0usize;
    for &count in counts {
        let n = count.max(0) as usize;
        let face = &face_indices[corner..corner + n];
        let normal = newell(points, face, left_handed);
        for &p in face {
            let a = &mut acc[p as usize];
            a[0] += normal[0];
            a[1] += normal[1];
            a[2] += normal[2];
        }
        corner += n;
    }
    let mut out = Vec::with_capacity(point_of.len() * 3);
    for &p in point_of {
        out.extend_from_slice(&unit(acc[p as usize]));
    }
    out
}

/// One normal per face, repeated at each of its corners (per-corner layout).
fn face_normals(
    points: &[[f32; 3]],
    counts: &[i32],
    face_indices: &[i32],
    face_of: &[u32],
    left_handed: bool,
) -> Vec<f32> {
    let mut per_face = Vec::with_capacity(counts.len());
    let mut corner = 0usize;
    for &count in counts {
        let n = count.max(0) as usize;
        per_face.push(unit(newell(points, &face_indices[corner..corner + n], left_handed)));
        corner += n;
    }
    let mut out = Vec::with_capacity(face_of.len() * 3);
    for &f in face_of {
        out.extend_from_slice(&per_face[f as usize]);
    }
    out
}

/// A polygon's area-weighted normal by Newell's method, which handles
/// non-planar polygons; zero for degenerate faces.
fn newell(points: &[[f32; 3]], face: &[i32], left_handed: bool) -> [f32; 3] {
    let n = face.len();
    let mut normal = [0f32; 3];
    if n < 3 {
        return normal;
    }
    for i in 0..n {
        let a = points[face[i] as usize];
        let b = points[face[(i + 1) % n] as usize];
        normal[0] += (a[1] - b[1]) * (a[2] + b[2]);
        normal[1] += (a[2] - b[2]) * (a[0] + b[0]);
        normal[2] += (a[0] - b[0]) * (a[1] + b[1]);
    }
    if left_handed { normal.map(|v| -v) } else { normal }
}

fn unit([x, y, z]: [f32; 3]) -> [f32; 3] {
    let len = (x * x + y * y + z * z).sqrt();
    if len > 0.0 {
        [x / len, y / len, z / len]
    } else {
        [0.0, 0.0, 1.0]
    }
}

/// `materialBind` face subsets, by child name, keeping only valid face indices.
fn read_subsets(prim: &usd::Prim, faces: usize) -> openusd::Result<Vec<(String, Vec<usize>)>> {
    let mut out = Vec::new();
    for child in prim.children()? {
        if child.type_name()?.as_deref() != Some("GeomSubset") {
            continue;
        }
        if token_attr(&child, "elementType").is_some_and(|t| t != "face") {
            continue;
        }
        if token_attr(&child, "familyName").is_some_and(|f| f != "materialBind") {
            continue;
        }
        let Some(indices) = ints(child.attribute("indices").get::<Value>()?) else {
            continue;
        };
        let faces: Vec<usize> = indices
            .into_iter()
            .filter(|&i| i >= 0 && (i as usize) < faces)
            .map(|i| i as usize)
            .collect();
        if let Some(name) = child.path().name() {
            out.push((name.to_owned(), faces));
        }
    }
    Ok(out)
}
