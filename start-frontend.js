// Helper to start react-scripts from the frontend directory
process.chdir(__dirname + '/frontend');
process.env.PORT = '3001';
process.env.BROWSER = 'none';
require('./frontend/node_modules/react-scripts/scripts/start');
