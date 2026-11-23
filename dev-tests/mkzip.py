import os, sys, zipfile, time

root = r'C:\Users\18824\WorkBuddy\2026-10-27-21-28-50\planquest\dist'
src_dir = 'PlanQuest-win64'
out = os.path.join(root, 'PlanQuest-win64-portable.new.zip')

base = os.path.join(root, src_dir)
files = []
for dirpath, dirnames, filenames in os.walk(base):
    for fn in filenames:
        full = os.path.join(dirpath, fn)
        rel = os.path.relpath(full, root).replace('\\', '/')
        files.append((full, rel))

files.sort()
total = sum(os.path.getsize(f) for f, _ in files)
print('files=%d total=%.1f MB' % (len(files), total / 1048576), flush=True)

t0 = time.time()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as z:
    done = 0
    for i, (full, rel) in enumerate(files, 1):
        z.write(full, rel)
        done += os.path.getsize(full)
        if i % 200 == 0 or i == len(files):
            print('%d/%d  %.0f MB  %.0fs' % (i, len(files), done / 1048576, time.time() - t0), flush=True)

print('ZIP_OK', out, os.path.getsize(out), 'in %.0fs' % (time.time() - t0), flush=True)
