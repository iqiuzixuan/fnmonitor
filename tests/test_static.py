"""Static checks: Python sources compile, shell scripts parse, the committed frontend
app/www/index.html equals a fresh build of ui-src/ (built in a temp copy, the real file is never
touched) and its inline script passes `node --check` when node is installed."""
import os
import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

from fnm_support import REPO, read_file


def _which(name):
    return shutil.which(name)


class PythonCompileTest(unittest.TestCase):
    def test_compile(self):
        files = [os.path.join(REPO, "app", "server.py"), os.path.join(REPO, "make_icon.py")]
        files += [os.path.join(REPO, "tools", f) for f in os.listdir(os.path.join(REPO, "tools")) if f.endswith(".py")]
        tmp = tempfile.mkdtemp(prefix="fnm-pyc-")
        try:
            for f in files:
                if os.path.exists(f):
                    with self.subTest(file=os.path.relpath(f, REPO)):
                        py_compile.compile(f, cfile=os.path.join(tmp, os.path.basename(f) + "c"), doraise=True)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(_which("bash"), "bash not available")
class ShellSyntaxTest(unittest.TestCase):
    def test_bash_n(self):
        scripts = [os.path.join(REPO, "cmd", f) for f in sorted(os.listdir(os.path.join(REPO, "cmd")))]
        scripts += [os.path.join(REPO, "build.sh")]
        for s in scripts:
            with self.subTest(script=os.path.relpath(s, REPO)):
                r = subprocess.run(["bash", "-n", s], capture_output=True, text=True)
                self.assertEqual(r.returncode, 0, r.stderr)
        r = subprocess.run(["sh", "-n", os.path.join(REPO, "tools", "build_ui.sh")], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)


@unittest.skipUnless(_which("sh"), "sh not available")
class FrontendBuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="fnm-ui-")
        shutil.copytree(os.path.join(REPO, "tools"), os.path.join(cls.tmp, "tools"))
        shutil.copytree(os.path.join(REPO, "ui-src"), os.path.join(cls.tmp, "ui-src"))
        os.makedirs(os.path.join(cls.tmp, "app", "www"))
        env = dict(os.environ)
        # build_ui.sh calls `python3`; make sure it is the interpreter running the tests
        bindir = os.path.join(cls.tmp, "bin")
        os.makedirs(bindir)
        os.symlink(sys.executable, os.path.join(bindir, "python3"))
        env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
        cls.res = subprocess.run(["sh", os.path.join(cls.tmp, "tools", "build_ui.sh")], capture_output=True,
                                 text=True, env=env, cwd=cls.tmp)
        cls.out = os.path.join(cls.tmp, "app", "www", "index.html")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_build_succeeds(self):
        self.assertEqual(self.res.returncode, 0, self.res.stdout + self.res.stderr)

    def test_committed_index_matches_fresh_build(self):
        self.assertEqual(self.res.returncode, 0, self.res.stderr)
        fresh = read_file(self.out, "rb")
        committed = read_file(os.path.join(REPO, "app", "www", "index.html"), "rb")
        self.assertTrue(fresh == committed,
                        "app/www/index.html is stale: edit ui-src/ and run `sh tools/build_ui.sh` (fresh %d B vs "
                        "committed %d B)" % (len(fresh), len(committed)))

    @unittest.skipUnless(_which("node"), "node not installed")
    def test_inline_script_node_check(self):
        t = read_file(self.out)
        a = t.rindex("<script>\n") + 9
        b = t.rindex("</script>")
        js = os.path.join(self.tmp, "check.js")
        with open(js, "w", encoding="utf-8") as f:
            f.write(t[a:b])
        r = subprocess.run(["node", "--check", js], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_pages_load_no_remote_resources(self):
        # CSP is default-src 'self': remote scripts / styles / images would silently break.
        # Plain <a href="https://…"> links are fine.
        pat = re.compile(r"<(?:script|img|iframe|audio|video|source)\b[^>]*\bsrc\s*=\s*[\"']?https?:"
                         r"|<link\b[^>]*\bhref\s*=\s*[\"']?https?:|url\(\s*[\"']?https?:", re.I)
        for name in ("index.html", "login.html"):
            html = read_file(os.path.join(REPO, "app", "www", name))
            self.assertEqual(pat.findall(html), [], name)

if __name__ == "__main__":
    unittest.main()
