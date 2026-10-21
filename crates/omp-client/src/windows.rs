use crate::Result;
use std::{mem::size_of, os::windows::io::AsRawHandle, process::Child, ptr};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE, LocalFree},
    Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        SetInformationJobObject,
    },
};
use zeroize::Zeroizing;

pub fn protect(bytes: &[u8], entropy: &[u8], decrypt: bool) -> Result<Zeroizing<Vec<u8>>> {
    if bytes.len() > 64 * 1024 || entropy.len() > 1024 {
        return Err("credential_too_large");
    }
    let input = CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr().cast_mut(),
    };
    let entropy = CRYPT_INTEGER_BLOB {
        cbData: entropy.len() as u32,
        pbData: entropy.as_ptr().cast_mut(),
    };
    let mut output: CRYPT_INTEGER_BLOB = unsafe { std::mem::zeroed() };
    // DPAPI borrows the two input buffers and allocates output with LocalAlloc.
    // No LOCAL_MACHINE flag: credentials use the current Windows user scope.
    let ok = unsafe {
        if decrypt {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        }
    };
    if ok == 0 {
        return Err("dpapi_failed");
    }
    let result = unsafe {
        Zeroizing::new(std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec())
    };
    unsafe {
        // DPAPI's plaintext output is cleared before releasing its allocation.
        if decrypt {
            std::ptr::write_bytes(output.pbData, 0, output.cbData as usize);
        }
        LocalFree(output.pbData.cast());
    }
    Ok(result)
}

pub struct Job(HANDLE);

impl Job {
    pub fn attach(child: &Child) -> Result<Self> {
        let handle = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if handle.is_null() {
            return Err("job_create_failed");
        }
        let job = Self(handle);
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) != 0
                && AssignProcessToJobObject(handle, child.as_raw_handle().cast()) != 0
        };
        if !ok {
            return Err("job_attach_failed");
        }
        Ok(job)
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
