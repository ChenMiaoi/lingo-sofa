// The OS must reclaim dev children even when the terminal kills the JS runner
// before it can handle Ctrl+C or run its finally block.
#[cfg(windows)]
fn main() {
    use lingo_sofa_omp_client::Job;
    use std::process::{Command, exit};

    let mut args = std::env::args_os().skip(1);
    let Some(program) = args.next() else {
        eprintln!("Expected a development command.");
        exit(1);
    };
    let mut child = Command::new(program)
        .args(args)
        .spawn()
        .unwrap_or_else(|error| {
            eprintln!("Cannot launch development command: {error}");
            exit(1);
        });
    let job = match Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            eprintln!("Cannot isolate development processes: {error}");
            exit(1);
        }
    };
    let code = child
        .wait()
        .ok()
        .and_then(|status| status.code())
        .unwrap_or(1);
    drop(job);
    exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("This development process guard is only needed on Windows.");
    std::process::exit(1);
}
