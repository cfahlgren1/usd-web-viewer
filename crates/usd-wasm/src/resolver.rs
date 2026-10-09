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
use std::sync::{Arc, Mutex, MutexGuard};

use openusd::ar::{self, Asset, ResolvedPath};

/// Layer bytes shared between the loader and its resolvers.
pub type Files = Arc<Mutex<Store>>;

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

/// Fetched layers by virtual path.
#[derive(Default)]
pub struct Store {
    /// Bytes not yet handed to a composing stage.
    pub bytes: HashMap<String, Vec<u8>>,
    /// Layers a composing stage took ownership of: present for this stage,
    /// gone for any later one.
    pub taken: Vec<String>,
}

/// Resolves virtual paths against the [`Store`], recording every layer that
/// was asked for but is not there yet so the caller can fetch it and recompose.
pub struct MemoryResolver {
    pub files: Files,
    pub missing: Rc<RefCell<BTreeSet<String>>>,
    /// Move bytes into the stage instead of copying them, so a layer is held
    /// once (by the stage) rather than twice while composing.
    pub take: bool,
    /// A layer copied rather than taken the first time it is opened: opening a
    /// stage reads its root layer twice.
    pub keep: RefCell<Option<String>>,
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
        let present = {
            let files = lock(&self.files);
            files.bytes.contains_key(asset_path) || (self.take && files.taken.iter().any(|t| t == asset_path))
        };
        if !is_layer_path(asset_path) || present {
            return Some(ResolvedPath::new(asset_path));
        }
        self.missing.borrow_mut().insert(asset_path.to_owned());
        None
    }

    fn resolve_for_new_asset(&self, asset_path: &str) -> Option<ResolvedPath> {
        Some(ResolvedPath::new(asset_path))
    }

    fn open_asset(&self, resolved_path: &ResolvedPath) -> io::Result<Box<dyn Asset>> {
        let key = resolved_path.to_string_lossy().into_owned();
        let first_root_read = self.keep.borrow().as_deref() == Some(key.as_str());
        if first_root_read {
            self.keep.replace(None);
        }
        let take = self.take && !first_root_read;
        let size = match lock(&self.files).bytes.get(&key) {
            Some(bytes) => bytes.len() as u64,
            None => return Err(io::Error::new(io::ErrorKind::NotFound, key)),
        };
        Ok(Box::new(StoredAsset {
            files: self.files.clone(),
            key,
            size,
            pos: 0,
            take,
        }))
    }

    fn get_modification_timestamp(&self, _: &str, _: &ResolvedPath) -> Option<std::time::SystemTime> {
        None
    }

    fn identity(&self) -> String {
        "usd-wasm-memory".to_owned()
    }
}

pub(crate) fn lock(files: &Files) -> MutexGuard<'_, Store> {
    files.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// A layer in the [`Store`], read in place. A full read in take mode moves
/// the buffer out of the store instead of copying it: format sniffing opens a
/// layer more than once, so ownership moves only when it is read whole.
struct StoredAsset {
    files: Files,
    key: String,
    size: u64,
    pos: u64,
    take: bool,
}

impl Read for StoredAsset {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let files = lock(&self.files);
        let Some(bytes) = files.bytes.get(&self.key) else {
            return Err(io::Error::new(io::ErrorKind::NotFound, self.key.clone()));
        };
        let start = (self.pos as usize).min(bytes.len());
        let n = buf.len().min(bytes.len() - start);
        buf[..n].copy_from_slice(&bytes[start..start + n]);
        self.pos += n as u64;
        Ok(n)
    }
}

impl Seek for StoredAsset {
    fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
        let next = match pos {
            SeekFrom::Start(n) => n as i64,
            SeekFrom::End(n) => self.size as i64 + n,
            SeekFrom::Current(n) => self.pos as i64 + n,
        };
        if next < 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "seek before start"));
        }
        self.pos = next as u64;
        Ok(self.pos)
    }
}

impl Asset for StoredAsset {
    fn size(&self) -> io::Result<u64> {
        Ok(self.size)
    }

    fn read_all(&mut self) -> io::Result<Vec<u8>> {
        if self.pos != 0 {
            let mut rest = Vec::new();
            self.read_to_end(&mut rest)?;
            return Ok(rest);
        }
        let mut files = lock(&self.files);
        let bytes = if self.take {
            let bytes = files.bytes.remove(&self.key);
            if bytes.is_some() {
                files.taken.push(self.key.clone());
            }
            bytes
        } else {
            files.bytes.get(&self.key).cloned()
        };
        self.pos = self.size;
        bytes.ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, self.key.clone()))
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
