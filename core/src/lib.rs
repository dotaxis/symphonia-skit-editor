//! Browser and native entry points for the PC skit editor. All operations are
//! pure byte transformations: this crate never writes a supplied game file.
pub mod assets;
pub mod semantics;
pub mod skp;
pub mod vm;

pub use skp::{compile, create, inspect, CreateSpec, Document, Edits};

#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;
#[cfg(feature = "wasm")]
pub type ApiError = JsValue;
#[cfg(not(feature = "wasm"))]
pub type ApiError = String;

fn api_error(error: impl ToString) -> ApiError {
    #[cfg(feature = "wasm")]
    {
        JsValue::from_str(&error.to_string())
    }
    #[cfg(not(feature = "wasm"))]
    {
        error.to_string()
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn parse_skit(bytes: &[u8]) -> Result<String, ApiError> {
    serde_json::to_string(&inspect(bytes).map_err(api_error)?).map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn compile_skit(bytes: &[u8], edits_json: &str) -> Result<Vec<u8>, ApiError> {
    let edits: Edits = serde_json::from_str(edits_json).map_err(api_error)?;
    compile(bytes, &edits).map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn create_skit(spec_json: &str) -> Result<Vec<u8>, ApiError> {
    let spec: CreateSpec = serde_json::from_str(spec_json).map_err(api_error)?;
    create(&spec).map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn author_skit(spec_json: &str) -> Result<Vec<u8>, ApiError> {
    semantics::author_skit(spec_json).map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn decode_texture(bytes: &[u8]) -> Result<String, ApiError> {
    serde_json::to_string(&assets::decode_texture(bytes).map_err(api_error)?).map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn inspect_assets(kind: &str, bytes: &[u8]) -> Result<String, ApiError> {
    match kind.to_ascii_lowercase().as_str() {
        "pac" => serde_json::to_string(&assets::parse_pac(bytes).map_err(api_error)?),
        "skitdata" => serde_json::to_string(&assets::parse_skitdata(bytes).map_err(api_error)?),
        "awb" => serde_json::to_string(&assets::parse_awb(bytes).map_err(api_error)?),
        "exe" => {
            serde_json::to_string(&assets::extract_animation_catalog(bytes).map_err(api_error)?)
        }
        _ => return Err(api_error("Asset kind must be pac, skitdata, awb or exe")),
    }
    .map_err(api_error)
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
pub fn decode_audio(bytes: &[u8]) -> Result<String, ApiError> {
    serde_json::to_string(&assets::decode_adx(bytes).map_err(api_error)?).map_err(api_error)
}
