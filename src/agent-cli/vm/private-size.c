// private-size FILE… — per file, "<private bytes> <allocated bytes>": the
// bytes of its data no APFS clone shares (getattrlist ATTR_CMNEXT_PRIVATESIZE),
// and all it has allocated (st_blocks) (ASS-69 AC3: du and ls count shared
// blocks, so every clone looks as big as its golden). ASS-403: VM disk use is
// measured by shared-size.c now, each block counted once; this gives a golden
// image's allocated size (what a new VM is charged) and the private sizes
// vm.bash falls back to where shared-size cannot read the extents.
// Node cannot call getattrlist; vm.bash builds this once (clang), on use.
#include <stdio.h>
#include <string.h>
#include <sys/attr.h>
#include <sys/stat.h>
#include <unistd.h>
struct reply { u_int32_t len; attribute_set_t returned; off_t privatesize; } __attribute__((packed));
int main(int argc, char **argv) {
  int rc = 0;
  for (int i = 1; i < argc; i++) {
    struct attrlist al; memset(&al, 0, sizeof al);
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr = ATTR_CMN_RETURNED_ATTRS;
    al.forkattr = ATTR_CMNEXT_PRIVATESIZE;  // with FSOPT_ATTR_CMN_EXTENDED, forkattr holds CMNEXT bits
    struct reply r; struct stat st;
    if (getattrlist(argv[i], &al, &r, sizeof r, FSOPT_ATTR_CMN_EXTENDED) != 0 || stat(argv[i], &st) != 0) { perror(argv[i]); rc = 1; continue; }
    if (!(r.returned.forkattr & ATTR_CMNEXT_PRIVATESIZE)) { fprintf(stderr, "%s: private size not reported\n", argv[i]); rc = 1; continue; }
    printf("%lld %lld\n", (long long)r.privatesize, (long long)st.st_blocks * 512);
  }
  return rc;
}
