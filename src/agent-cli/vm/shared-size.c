// shared-size FILE… [-- FILE…]… — ASS-403: the space a set of disk files
// occupies on the volume, each block counted once however many APFS clones
// share it. The arguments are owners (a VM's or golden image's disk files),
// separated by "--", in order of priority; one line per owner, in that order:
// "<own> <shared> <allocated>" bytes — own, the blocks no other owner in the
// set has (what deleting it frees, as far as the set goes); shared, the blocks
// it has with another owner when it is the first owner (by order) to have them,
// so each shared block is counted once, by the first; allocated, all its files
// have allocated (st_blocks), shared or not. The owners' own and shared bytes
// add up to the set's footprint, the union of their blocks.
// Each file's blocks are read as physical extents: SEEK_DATA/SEEK_HOLE for its
// data, then fcntl F_LOG2PHYS_EXT over each data run for the device offsets
// (on APFS the container's: a clone's unwritten blocks have its source's, a
// copy-on-write block a new one). A run not on the device yet (dirty in the
// page cache: devoffset -1, as in a running VM) is counted as its owner's own:
// whatever it overwrote, it will be a new block. Fails (1), printing nothing,
// when a file's extents cannot be read; vm.bash then falls back to APFS
// private sizes (private-size.c). Node cannot call fcntl; vm.bash builds this
// once (clang), on use.
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

struct event { off_t at; int owner; int step; };   // step +1: an extent of owner's starts at at; -1: one ends
static struct event *events; static size_t nevents, capevents;

static void add(off_t at, int owner, int step) {
  if (nevents == capevents) {
    capevents = capevents ? capevents * 2 : 65536;
    if (!(events = realloc(events, capevents * sizeof *events))) { perror("shared-size"); exit(1); }
  }
  events[nevents++] = (struct event){ at, owner, step };
}

static int by_offset(const void *a, const void *b) {
  off_t x = ((const struct event *)a)->at, y = ((const struct event *)b)->at;
  return x < y ? -1 : x > y;
}

// extents — path's physical extents added as owner's events; its not-yet-allocated data to *own.
static int extents(const char *path, int owner, long long *own, long long *allocated) {
  int fd = open(path, O_RDONLY);
  struct stat st;
  if (fd < 0 || fstat(fd, &st) != 0) { perror(path); if (fd >= 0) close(fd); return -1; }
  *allocated += (long long)st.st_blocks * 512;
  for (off_t at = 0; at < st.st_size; ) {
    off_t data = lseek(fd, at, SEEK_DATA), hole;
    if (data < 0) { if (errno == ENXIO) break; perror(path); close(fd); return -1; }
    if ((hole = lseek(fd, data, SEEK_HOLE)) < 0) hole = st.st_size;
    for (off_t o = data; o < hole; ) {
      struct log2phys l = { 0 };
      l.l2p_contigbytes = hole - o; l.l2p_devoffset = o;
      if (fcntl(fd, F_LOG2PHYS_EXT, &l) != 0) { fprintf(stderr, "%s: extent at %lld: %s\n", path, (long long)o, strerror(errno)); close(fd); return -1; }
      off_t n = l.l2p_contigbytes;
      if (n <= 0) { fprintf(stderr, "%s: no extent at %lld\n", path, (long long)o); close(fd); return -1; }
      if (n > hole - o) n = hole - o;
      if (l.l2p_devoffset < 0) *own += n;
      else { add(l.l2p_devoffset, owner, 1); add(l.l2p_devoffset + n, owner, -1); }
      o += n;
    }
    at = hole;
  }
  close(fd);
  return 0;
}

int main(int argc, char **argv) {
  int owners = 1;
  for (int i = 1; i < argc; i++) if (strcmp(argv[i], "--") == 0) owners++;
  long long *own = calloc(owners, sizeof *own), *shared = calloc(owners, sizeof *shared), *allocated = calloc(owners, sizeof *allocated);
  int *depth = calloc(owners, sizeof *depth);
  if (!own || !shared || !allocated || !depth) { perror("shared-size"); return 1; }
  for (int i = 1, owner = 0; i < argc; i++) {
    if (strcmp(argv[i], "--") == 0) { owner++; continue; }
    if (extents(argv[i], owner, &own[owner], &allocated[owner]) != 0) return 1;
  }
  qsort(events, nevents, sizeof *events, by_offset);
  // Sweep the device: between two event offsets the owners with depth > 0 hold every block.
  int holding = 0;   // owners with depth > 0
  for (size_t i = 0; i < nevents; ) {
    off_t at = events[i].at;
    for (; i < nevents && events[i].at == at; i++) {
      int o = events[i].owner, was = depth[o];
      depth[o] += events[i].step;
      holding += (depth[o] > 0) - (was > 0);
    }
    if (holding == 0 || i == nevents) continue;
    off_t length = events[i].at - at;
    int first = 0;
    while (depth[first] <= 0) first++;
    if (holding == 1) own[first] += length; else shared[first] += length;
  }
  for (int o = 0; o < owners; o++) printf("%lld %lld %lld\n", own[o], shared[o], allocated[o]);
  return 0;
}
