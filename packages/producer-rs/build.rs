fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Same proto file the Node producer and aggregators use.
    tonic_build::configure()
        .build_client(false)
        .compile_protos(&["../shared/proto/events.proto"], &["../shared/proto"])?;
    println!("cargo:rerun-if-changed=../shared/proto/events.proto");
    Ok(())
}
