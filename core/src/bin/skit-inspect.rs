use std::{env, fs, process};
fn main() {
    let result = (|| -> Result<(), String> {
        let path = env::args()
            .nth(1)
            .ok_or("Usage: skit-inspect /path/to/file.SKP")?;
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        println!(
            "{}",
            serde_json::to_string(&tos_skit_core::inspect(&bytes)?).map_err(|e| e.to_string())?
        );
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("{error}");
        process::exit(1);
    }
}
