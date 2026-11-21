// The Nexconn engine references Node's path module only in its Node-specific branch.
// This tiny shim keeps the browser bundle resolvable; browser execution does not use it.
module.exports = {
    join: (...parts) => parts.join('/').replace(/\/+/g, '/'),
    resolve: (...parts) => `/${parts.join('/').replace(/\/+/g, '/')}`
};
