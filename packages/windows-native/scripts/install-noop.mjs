// A package containing binding.gyp otherwise receives npm's implicit
// `node-gyp rebuild` install hook. Native builds belong exclusively to the
// explicit Windows CI `build:native` step; published binaries are verified by
// the production loader.
