using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography.X509Certificates;

public static class CaptureCertificateWizard {
    [StructLayout(LayoutKind.Sequential)]
    private struct Source {
        public uint Size, SubjectChoice;
        public IntPtr Certificate;
        public uint Flags;
        public IntPtr Password;
    }

    [DllImport("cryptui.dll", CharSet = CharSet.Unicode, ExactSpelling = true, SetLastError = true)]
    private static extern bool CryptUIWizImport(uint flags, IntPtr parent, string title,
        ref Source source, IntPtr destination);

    public static void Import(string file) {
        using (var cert = new X509Certificate2(file))
        using (var root = new X509Store(StoreName.Root, StoreLocation.CurrentUser)) {
            root.Open(OpenFlags.ReadWrite | OpenFlags.OpenExistingOnly);
            var source = new Source {
                Size = (uint)Marshal.SizeOf(typeof(Source)),
                SubjectChoice = 2, // CRYPTUI_WIZ_IMPORT_SUBJECT_CERT_CONTEXT
                Certificate = cert.Handle
            };
            const uint fixedDestination = 0x00010000, allowCertificate = 0x00020000;
            if (!CryptUIWizImport(fixedDestination | allowCertificate, IntPtr.Zero,
                "CrazyWaterWorld - Current User Root", ref source, root.StoreHandle))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
