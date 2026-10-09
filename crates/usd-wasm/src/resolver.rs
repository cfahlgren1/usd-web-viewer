//! An in-memory asset resolver over "virtual paths".
//!
//! The browser side maps every URL to a virtual absolute path (`/<host>/<path>`)
//! so relative asset paths can be anchored with plain POSIX rules here, and
//! maps them back to URLs when it fetches. Layers live in a shared map filled
//! before composition; nothing is ever read from a filesystem or network.

use std::cell::RefCell;
use std::collections::{BTreeSet, HashMap};
use std::io::{self, Read, Seek, SeekFrom};
use std::rc::Rc;
use std::sync::Arc;

use openusd::ar::{self, Asset, ResolvedPath};

/// File bytes keyed by virtual path, shared between the loader and resolver.
pub type Files = Rc<RefCell<HashMap<String, Arc<[u8]>>>>;

/// Extensions composition reads as layers. Anything else (textures, MDL) is
/// an opaque asset that resolves without being present.
pub fn is_layer_path(path: &str) -> bool {
    matches!(extension(path).as_str(), "usd" | "usda" | "usdc" | "usdz")
}

fn extension(path: &str) -> String {
    let name = path.rsplit('/').next().unwrap_or(path);
    match name.rfind('.') {
        Some(dot) => name[dot + 1..].to_ascii_lowercase(),
        None => String::new(),
    }
}

/// Turns an authored asset path into a virtual path, anchored at the virtual
/// path of the layer that authored it. Returns `None` for empty paths.
pub fn anchor_path(asset_path: &str, anchor: Option<&str>) -> Option<String> {
    let path = asset_path.trim().replace('\\', "/");
    if path.is_empty() {
        return None;
    }
    if let Some(rest) = path.strip_prefix("https://").or_else(|| path.strip_prefix("http://")) {
        return Some(normalize(&format!("/{rest}")));
    }
    if let Some(rest) = path.strip_prefix("file://") {
        return Some(normalize(rest));
    }
    if path.starts_with('/') {
        return Some(normalize(&path));
    }
    let dir = match anchor {
        Some(anchor) => anchor.rsplit_once('/').map_or("", |(dir, _)| dir),
        None => "",
    };
    Some(normalize(&format!("{dir}/{path}")))
}

/// Collapses `.`, `..` and repeated separators, and drops a query string.
fn normalize(path: &str) -> String {
    let path = path.split(['?', '#']).next().unwrap_or(path);
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            part => parts.push(part),
        }
    }
    format!("/{}", parts.join("/"))
}

/// Resolves virtual paths against [`Files`], recording every layer that was
/// asked for but is not there yet so the caller can fetch it and recompose.
pub struct MemoryResolver {
    pub files: Files,
    pub missing: Rc<RefCell<BTreeSet<String>>>,
}

impl ar::Resolver for MemoryResolver {
    fn create_identifier(&self, asset_path: &str, anchor: Option<&ResolvedPath>) -> String {
        let anchor = anchor.map(|a| a.to_string_lossy().into_owned());
        anchor_path(asset_path, anchor.as_deref()).unwrap_or_default()
    }

    fn resolve(&self, asset_path: &str) -> Option<ResolvedPath> {
        if asset_path.is_empty() {
            return None;
        }
        if !is_layer_path(asset_path) || self.files.borrow().contains_key(asset_path) {
            return Some(ResolvedPath::new(asset_path));
        }
        self.missing.borrow_mut().insert(asset_path.to_owned());
        None
    }

    fn resolve_for_new_asset(&self, asset_path: &str) -> Option<ResolvedPath> {
        Some(ResolvedPath::new(asset_path))
    }

    fn open_asset(&self, resolved_path: &ResolvedPath) -> io::Result<Box<dyn Asset>> {
        let key = resolved_path.to_string_lossy();
        let bytes = self.files.borrow().get(key.as_ref()).cloned();
        match bytes {
            Some(bytes) => Ok(Box::new(SharedBytes { bytes, pos: 0 })),
            None => Err(io::Error::new(io::ErrorKind::NotFound, key.into_owned())),
        }
    }

    fn get_modification_timestamp(&self, _: &str, _: &ResolvedPath) -> Option<std::time::SystemTime> {
        None
    }

    fn identity(&self) -> String {
        "usd-wasm-memory".to_owned()
    }
}

/// A read cursor over shared bytes, so opening a layer does not copy the map entry.
struct SharedBytes {
    bytes: Arc<[u8]>,
    pos: u64,
}

impl Read for SharedBytes {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let start = (self.pos as usize).min(self.bytes.len());
        let n = buf.len().min(self.bytes.len() - start);
        buf[..n].copy_from_slice(&self.bytes[start..start + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for SharedBytes {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let len = self.bytes.len() as i64;
        let next = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => len + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

impl Asset for SharedBytes {
    fn size(&self) -> io::Result<u64> {
        Ok(self.bytes.len() as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anchors_relative_paths() {
        let root = "/huggingface.co/datasets/a/b/resolve/main/x/root.usd";
        assert_eq!(
            anchor_path("./payloads/base.usda", Some(root)).unwrap(),
            "/huggingface.co/datasets/a/b/resolve/main/x/payloads/base.usda"
        );
        assert_eq!(
            anchor_path("../tex/a.png", Some(root)).unwrap(),
            "/huggingface.co/datasets/a/b/resolve/main/tex/a.png"
        );
        assert_eq!(
            anchor_path("https://cdn.example/a/b.usd?x=1", Some(root)).unwrap(),
            "/cdn.example/a/b.usd"
        );
        assert_eq!(anchor_path("SubUSDs\\textures\\t.jpg", Some("/h/r.usd")).unwrap(), "/h/SubUSDs/textures/t.jpg");
    }
}
