use crate::ApiError;
use std::{net::SocketAddr, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
};

pub struct ManagedTurn {
    pub child: Child,
    // 父进程保留此连接；异常退出或结束会话时 EOF 通知独立 owner 收尾整棵进程树。
    _control: TcpStream,
}

pub async fn spawn(executable: &Path, args: &[String]) -> Result<ManagedTurn, ApiError> {
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let address = listener.local_addr()?;
    let token = uuid::Uuid::new_v4().to_string();
    let encoded = serde_json::to_string(args)?;
    let mut command = Command::new(std::env::current_exe()?);
    command
        .arg("turn-owner")
        .arg(address.to_string())
        .arg(&token)
        .arg(executable)
        .arg(encoded)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (name, _) in std::env::vars() {
        if name.starts_with("CODEX_PANEL_") || name.starts_with("CODEX_TASKBOARD_") {
            command.env_remove(name);
        }
    }
    #[cfg(unix)]
    {
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let accepted = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let (mut stream, peer) = listener.accept().await?;
            if !peer.ip().is_loopback() {
                continue;
            }
            // 握手上限防止其他本机连接拖住 owner 建立过程。
            let handshake = tokio::time::timeout(Duration::from_millis(500), async {
                let mut line = Vec::new();
                for _ in 0..129 {
                    let byte = stream.read_u8().await?;
                    if byte == b'\n' {
                        return Ok::<_, std::io::Error>(line);
                    }
                    line.push(byte);
                }
                Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Control token exceeded its limit",
                ))
            })
            .await;
            if matches!(handshake,Ok(Ok(ref line)) if line.as_slice()==token.as_bytes()) {
                stream.write_all(&[1]).await?;
                return Ok::<_, std::io::Error>(stream);
            }
        }
    })
    .await;
    match accepted {
        Ok(Ok(control)) => Ok(ManagedTurn {
            child,
            _control: control,
        }),
        _ => {
            let _ = child.kill().await;
            Err(ApiError::new(
                502,
                "TURN_OWNER_UNAVAILABLE",
                "Turn owner control connection failed",
            ))
        }
    }
}

pub async fn run(args: &[String]) -> Result<(), ApiError> {
    if args.len() != 4 {
        return Err(ApiError::new(
            400,
            "INVALID_TURN_OWNER",
            "Turn owner requires control address, token, executable, and arguments",
        ));
    }
    #[cfg(unix)]
    if unsafe { libc::getpgrp() != libc::getpid() } {
        return Err(ApiError::new(
            400,
            "INVALID_TURN_OWNER",
            "Turn owner must run in its own process group",
        ));
    }
    let address: SocketAddr = args[0]
        .parse()
        .map_err(|_| ApiError::new(400, "INVALID_TURN_OWNER", "Invalid control address"))?;
    if !address.ip().is_loopback() {
        return Err(ApiError::new(
            400,
            "INVALID_TURN_OWNER",
            "Control address must be loopback",
        ));
    }
    let token = &args[1];
    if token.len() > 128 || token.contains(['\r', '\n']) {
        return Err(ApiError::new(
            400,
            "INVALID_TURN_OWNER",
            "Invalid control token",
        ));
    }
    let child_args: Vec<String> = serde_json::from_str(&args[3])?;
    let mut control = TcpStream::connect(address).await?;
    control.write_all(format!("{token}\n").as_bytes()).await?;
    if tokio::time::timeout(Duration::from_secs(5), control.read_u8())
        .await
        .ok()
        .and_then(Result::ok)
        != Some(1)
    {
        return Err(ApiError::new(
            502,
            "TURN_OWNER_UNAVAILABLE",
            "Parent did not acknowledge the control connection",
        ));
    }
    let mut command = Command::new(&args[2]);
    command
        .args(child_args)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    {
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn()?;
    let pid = child.id();
    let mut byte = [0u8; 1];
    tokio::select! {
        status=child.wait()=>{
            let status=status?;
            #[cfg(unix)] {
                use std::os::unix::process::ExitStatusExt;
                if let Some(signal)=status.signal(){unsafe{libc::raise(signal);}}
            }
            std::process::exit(status.code().unwrap_or(1));
        }
        _=control.read(&mut byte)=>{
            terminate_owned_child(pid).await;
            std::process::exit(1);
        }
    }
}

async fn terminate_owned_child(pid: Option<u32>) {
    #[cfg(unix)]
    {
        let _ = pid;
        // owner 由 spawn 放入独立进程组；只结束本次运行的组，绝不搜索用户的其他 Codex。
        unsafe {
            libc::kill(-(std::process::id() as i32), libc::SIGKILL);
        }
    }
    #[cfg(windows)]
    {
        if let Some(pid) = pid {
            let _ = Command::new("taskkill.exe")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .await;
        }
    }
}
