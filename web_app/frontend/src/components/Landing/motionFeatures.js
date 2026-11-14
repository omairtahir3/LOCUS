// framer-motion's DOM animation features, split out so LazyMotion can load
// them after first paint instead of shipping them in the main bundle.
export { domAnimation as default } from 'framer-motion';
