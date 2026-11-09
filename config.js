// ALL SETTINGS LIVE HERE. Edit this file only. Never share/upload it publicly.
module.exports = {
  PORT: 4000,
  MONGO_URI: 'mongodb+srv://doremondg55_db_user:UHw7eqhBHqGxl2BF@cluster0.o8hbxmd.mongodb.net/annieapi?appName=Cluster0',
  JWT_SECRET: 'c4f40641cb618008791c1600ff726d72d49223006128993e373f4c3985422f8b',
  ADMIN_PASS: 'sexy',   // password for the admin panel (change this to something strong!)
  ADMIN_PATH: '/nazriya',  // admin panel URL -> yoursite.com/nazriya
  ADMIN_DAYS: 30,          // admin stays logged in this many days (panel opens directly)
  GOOGLE_CLIENT_ID: '',                         // optional, for "Sign in with Google"
  DEVELOPER: 'heartfailer',                     // shown in every page footer
  // Logos on the home page ("Works with" strip). Put the image files in /public/logos/
  // and list them here. Empty list = strip hidden.
  // Example: BRANDS: [{ name: 'Platform name', logo: '/logos/platform.svg' }],
  BRANDS: [],
  // Starting defaults (you can change all of these later from /nazriya > Settings)
  DEFAULTS: {
    upstream: 'https://anniemusicapi.teamgod.online',
    defaultRpm: 30, freeDays: 30,
    freeAudio: 500, freeVideo: 25, freeSearch: 500,
    maintenance: false, off: []
  }
};
