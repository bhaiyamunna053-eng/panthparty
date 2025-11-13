// server.js - PANTHPARTY Backend Server with Admin Controls, Playlist & Chat
const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Store room data
const rooms = new Map();

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Room data structure
class Room {
  constructor(roomId, adminId, adminName) {
    this.roomId = roomId;
    this.users = new Map(); // socketId -> {nickname, isAdmin}
    this.admin = adminId;
    this.currentVideo = 'uzwgt8uGt90'; // Default video
    this.playlist = []; // Array of video IDs
    this.currentPlaylistIndex = 0;
    this.isPlaying = false;
    this.currentTime = 0;
    this.lastUpdate = Date.now();
    this.chatHistory = [];
  }

  addUser(socketId, nickname, isAdmin = false) {
    this.users.set(socketId, { nickname, isAdmin });
    
    // Send join message to chat
    this.addChatMessage({
      type: 'system',
      message: `${nickname} joined the party`,
      timestamp: Date.now()
    });
  }

  removeUser(socketId) {
    const user = this.users.get(socketId);
    this.users.delete(socketId);
    
    if (user) {
      this.addChatMessage({
        type: 'system',
        message: `${user.nickname} left the party`,
        timestamp: Date.now()
      });
    }
    
    // If admin leaves, assign new admin
    if (this.admin === socketId && this.users.size > 0) {
      const newAdmin = Array.from(this.users.keys())[0];
      this.admin = newAdmin;
      const newAdminUser = this.users.get(newAdmin);
      newAdminUser.isAdmin = true;
      return { remainingUsers: this.users.size, newAdmin };
    }
    
    return { remainingUsers: this.users.size, newAdmin: null };
  }

  isUserAdmin(socketId) {
    const user = this.users.get(socketId);
    return user && user.isAdmin;
  }

  updateState(isPlaying, currentTime) {
    this.isPlaying = isPlaying;
    this.currentTime = currentTime;
    this.lastUpdate = Date.now();
  }

  addChatMessage(message) {
    this.chatHistory.push(message);
    // Keep only last 100 messages
    if (this.chatHistory.length > 100) {
      this.chatHistory.shift();
    }
  }

  setPlaylist(videoIds) {
    this.playlist = videoIds;
    this.currentPlaylistIndex = 0;
  }

  nextVideo() {
    if (this.playlist.length > 0) {
      this.currentPlaylistIndex = (this.currentPlaylistIndex + 1) % this.playlist.length;
      this.currentVideo = this.playlist[this.currentPlaylistIndex];
      this.updateState(true, 0);
      return this.currentVideo;
    }
    return null;
  }

  previousVideo() {
    if (this.playlist.length > 0) {
      this.currentPlaylistIndex = (this.currentPlaylistIndex - 1 + this.playlist.length) % this.playlist.length;
      this.currentVideo = this.playlist[this.currentPlaylistIndex];
      this.updateState(true, 0);
      return this.currentVideo;
    }
    return null;
  }

  getState() {
    let adjustedTime = this.currentTime;
    if (this.isPlaying) {
      const elapsed = (Date.now() - this.lastUpdate) / 1000;
      adjustedTime += elapsed;
    }
    return {
      videoId: this.currentVideo,
      isPlaying: this.isPlaying,
      currentTime: adjustedTime,
      userCount: this.users.size,
      admin: this.admin,
      users: Array.from(this.users.entries()).map(([id, data]) => ({
        id,
        nickname: data.nickname,
        isAdmin: data.isAdmin
      })),
      playlist: this.playlist,
      currentPlaylistIndex: this.currentPlaylistIndex,
      hasPlaylist: this.playlist.length > 0
    };
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room
  socket.on('join-room', (data) => {
    const { roomId, nickname } = data;
    console.log(`${socket.id} (${nickname}) joining room: ${roomId}`);
    
    socket.join(roomId);
    socket.roomId = roomId;

    // Create or get room
    let isNewRoom = false;
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Room(roomId, socket.id, nickname));
      isNewRoom = true;
    }

    const room = rooms.get(roomId);
    const isAdmin = isNewRoom || room.users.size === 0;
    room.addUser(socket.id, nickname, isAdmin);

    // Send current room state to the new user
    socket.emit('room-state', room.getState());
    
    // Send chat history
    socket.emit('chat-history', room.chatHistory);

    // Notify all users in room
    io.to(roomId).emit('user-list-update', {
      users: Array.from(room.users.entries()).map(([id, data]) => ({
        id,
        nickname: data.nickname,
        isAdmin: data.isAdmin
      })),
      admin: room.admin
    });

    // Broadcast join message to others
    socket.to(roomId).emit('chat-message', {
      type: 'system',
      message: `${nickname} joined the party`,
      timestamp: Date.now()
    });

    console.log(`Room ${roomId} now has ${room.users.size} users`);
  });

  // Chat message
  socket.on('chat-message', (data) => {
    const room = rooms.get(socket.roomId);
    if (room) {
      const user = room.users.get(socket.id);
      if (user) {
        const message = {
          type: 'user',
          nickname: user.nickname,
          message: data.message,
          timestamp: Date.now(),
          isAdmin: user.isAdmin
        };
        room.addChatMessage(message);
        io.to(socket.roomId).emit('chat-message', message);
      }
    }
  });

  // Admin-only controls
  const requireAdmin = (callback) => {
    return (data) => {
      const room = rooms.get(socket.roomId);
      if (!room) return;
      
      if (!room.isUserAdmin(socket.id)) {
        socket.emit('error-message', 'Only the room admin can control playback');
        return;
      }
      
      callback(room, data);
    };
  };

  // Play event (admin only)
  socket.on('play', requireAdmin((room, data) => {
    room.updateState(true, data.time);
    io.to(socket.roomId).emit('play', {
      time: data.time,
      from: socket.id
    });
  }));

  // Pause event (admin only)
  socket.on('pause', requireAdmin((room, data) => {
    room.updateState(false, data.time);
    io.to(socket.roomId).emit('pause', {
      time: data.time,
      from: socket.id
    });
  }));

  // Video change event (admin only)
  socket.on('video-change', requireAdmin((room, data) => {
    room.currentVideo = data.videoId;
    room.updateState(false, 0);
    io.to(socket.roomId).emit('video-change', {
      videoId: data.videoId,
      from: socket.id
    });
  }));

  // Playlist load (admin only)
  socket.on('load-playlist', requireAdmin((room, data) => {
    room.setPlaylist(data.videoIds);
    room.currentVideo = data.videoIds[0] || room.currentVideo;
    room.updateState(false, 0);
    
    io.to(socket.roomId).emit('playlist-loaded', {
      playlist: room.playlist,
      currentIndex: room.currentPlaylistIndex,
      videoId: room.currentVideo
    });
  }));

  // Next video (admin only)
  socket.on('next-video', requireAdmin((room) => {
    const nextVideoId = room.nextVideo();
    if (nextVideoId) {
      io.to(socket.roomId).emit('video-change', {
        videoId: nextVideoId,
        from: socket.id,
        playlistIndex: room.currentPlaylistIndex
      });
    }
  }));

  // Previous video (admin only)
  socket.on('previous-video', requireAdmin((room) => {
    const prevVideoId = room.previousVideo();
    if (prevVideoId) {
      io.to(socket.roomId).emit('video-change', {
        videoId: prevVideoId,
        from: socket.id,
        playlistIndex: room.currentPlaylistIndex
      });
    }
  }));

  // Seek event (admin only)
  socket.on('seek', requireAdmin((room, data) => {
    room.updateState(room.isPlaying, data.time);
    socket.to(socket.roomId).emit('seek', {
      time: data.time,
      from: socket.id
    });
  }));

  // Sync request - available to all users
  socket.on('request-sync', () => {
    const room = rooms.get(socket.roomId);
    if (room) {
      socket.emit('sync-state', room.getState());
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        const result = room.removeUser(socket.id);
        
        if (result.remainingUsers === 0) {
          // Delete empty room after 5 minutes
          setTimeout(() => {
            const currentRoom = rooms.get(socket.roomId);
            if (currentRoom && currentRoom.users.size === 0) {
              rooms.delete(socket.roomId);
              console.log(`Room ${socket.roomId} deleted`);
            }
          }, 5 * 60 * 1000);
        } else {
          // Notify remaining users
          io.to(socket.roomId).emit('user-list-update', {
            users: Array.from(room.users.entries()).map(([id, data]) => ({
              id,
              nickname: data.nickname,
              isAdmin: data.isAdmin
            })),
            admin: room.admin
          });
          
          // If new admin was assigned
          if (result.newAdmin) {
            const newAdminUser = room.users.get(result.newAdmin);
            io.to(socket.roomId).emit('chat-message', {
              type: 'system',
              message: `${newAdminUser.nickname} is now the room admin`,
              timestamp: Date.now()
            });
          }
        }
      }
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// API Routes
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    userCount: room.users.size,
    currentVideo: room.currentVideo
  }));
  res.json(roomList);
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    activeRooms: rooms.size,
    timestamp: new Date().toISOString()
  });
});

// Start server
http.listen(PORT, () => {
  console.log(`🎉 PANTHPARTY Server running on port ${PORT}`);
  console.log(`Visit http://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, closing server...');
  http.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});


module.exports = { app, io };
