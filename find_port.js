const net = require("net");
const srv = net.createServer();
srv.listen(0, () => {
  const port = srv.address().port;
  srv.close(() => console.log(port));
});
