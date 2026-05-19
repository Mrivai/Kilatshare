import express from "express";
import path from "path";
import { createServer } from "http";
import { Server } from "socket.io";
import { createServer as createViteServer } from "vite";

async function startServer() {
  const app = express();
  const httpServer = createServer(app);
  const io = new Server(httpServer, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"]
    }
  });

  const PORT = 3000;

  // Track users by their public IP
  // In Cloud Run, the public IP is usually in x-forwarded-for
  io.on("connection", (socket) => {
    const clientIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
    const room = `ip-${clientIp}`;
    
    socket.join(room);
    console.log(`User connected: ${socket.id} in room: ${room}`);

    // Handle initial identity
    socket.on("identity", (identity) => {
      socket.data.identity = identity;
      socket.to(room).emit("user-connected", { id: socket.id, ...identity });
      
      // Also send existing peers to the new user
      const clients = io.sockets.adapter.rooms.get(room);
      if (clients) {
        for (const clientId of clients) {
          if (clientId !== socket.id) {
            const clientSocket = io.sockets.sockets.get(clientId);
            if (clientSocket && clientSocket.data.identity) {
              socket.emit("user-connected", { id: clientId, ...clientSocket.data.identity });
            } else {
               socket.emit("user-connected", { id: clientId, type: 'desktop', name: 'Alat Lain' });
            }
          }
        }
      }
    });

    // Handle signaling
    socket.on("signal", ({ to, signal }) => {
      io.to(to).emit("signal", { from: socket.id, signal });
    });

    socket.on("disconnect", () => {
      socket.to(room).emit("user-disconnected", socket.id);
      console.log(`User disconnected: ${socket.id}`);
    });
    
    // Allow users to discover others manually if IP discovery fails or for testing
    socket.on("join-manual-room", (manualRoom) => {
        socket.leave(room);
        socket.join(manualRoom);
        socket.to(manualRoom).emit("user-connected", socket.id);
    });
  });

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
