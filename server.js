// server.js - PANTHPARTY Backend Server with Advanced Room Management
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

// Room data structure with admin controls
class Room {
  constructor(roomId, roomName, adminPassword, joiningId, duration, apiKey) {
    this.roomId = roomId;
    this.roomName = roomName;
    this.adminPassword = adminPassword;
    this.joiningId = joiningId;
    this.admins = new Set();
    this.normalUsers = new Set();
    this.currentVideo = 'uzwgt8uGt90';
    this.isPlaying = false;
    this.currentTime = 0;
    this.lastUpdate = Date.now();
    this.createdAt = Date.now();
    this.duration = duration; // in minutes
    this.expiresAt = Date.now() + (duration * 60 * 1000);
    this.apiKey = apiKey;
    this.autoDestroyTimer = null;
    this.roomDestructionTimer = null;
    
    // Set room destruction timer
    if (duration > 0) {
      this.roomDestructionTimer = setTimeout(() => {
        this.destroyRoom('duration_expired');
      }, duration * 60 * 1000);
    }
  }

  addAdmin(socketId, username) {
    this.admins.add(socketId);
    this.cancelAutoDestroy();
    return {
      role: 'admin',
      username: username
    };
  }

  addNormalUser(socketId, username) {
    this.normalUsers.add(socketId);
    return {
      role: 'user',
      username: username
    };
  }

  removeUser(socketId) {
    const wasAdmin = this.admins.has(socketId);
    this.admins.delete(socketId);
    this.normalUsers.delete(socketId);
    
    // If last admin left, start auto-destroy timer
    if (wasAdmin && this.admins.size === 0) {
      this.startAutoDestroy();
    }
    
    return {
      totalUsers: this.admins.size + this.normalUsers.size,
      wasAdmin: wasAdmin,
      remainingAdmins: this.admins.size
    };
  }

  startAutoDestroy() {
    // If no admins in room, destroy after 2 minutes
    if (this.autoDestroyTimer) {
      clearTimeout(this.autoDestroyTimer);
    }
    
    console.log(`Room ${this.roomId}: No admins left. Auto-destroy in 2 minutes.`);
    
    this.autoDestroyTimer = setTimeout(() => {
      this.destroyRoom('no_admin');
    }, 2 * 60 * 1000);
  }

  cancelAutoDestroy() {
    if (this.autoDestroyTimer) {
      clearTimeout(this.autoDestroyTimer);
      this.autoDestroyTimer = null;
      console.log(`Room ${this.roomId}: Auto-destroy cancelled (admin joined).`);
    }
  }

  destroyRoom(reason) {
    console.log(`Room ${this.roomId}: Destroying room. Reason: ${reason}`);
    
    // Clear all timers
    if (this.autoDestroyTimer) {
      clearTimeout(this.autoDestroyTimer);
    }
    if (this.roomDestructionTimer) {
      clearTimeout(this.roomDestructionTimer);
    }
    
    // Notify all users
    const allUsers = [...this.admins, ...this.normalUsers];
    allUsers.forEach(socketId => {
      io.to(socketId).emit('room-destroyed', {
        reason: reason,
        message: reason === 'duration_expired' 
          ? 'Room duration has expired' 
          : 'Room destroyed - No admin present'
      });
    });
    
    // Remove from rooms map
    rooms.delete(this.roomId);
  }

  isAdmin(socketId) {
    return this.admins.has(socketId);
  }

  hasExpired() {
    return Date.now() > this.expiresAt;
  }

  getRemainingTime() {
    const remaining = this.expiresAt - Date.now();
    return Math.max(0, Math.floor(remaining / 1000)); // in seconds
  }

  updateState(isPlaying, currentTime) {
    this.isPlaying = isPlaying;
    this.currentTime = currentTime;
    this.lastUpdate = Date.now();
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
      adminCount: this.admins.size,
      userCount: this.normalUsers.size,
      totalUsers: this.admins.size + this.normalUsers.size,
      remainingTime: this.getRemainingTime(),
      hasProMode: !!this.apiKey,
      roomName: this.roomName
    };
  }
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Create room (admin only)
  socket.on('create-room', (data) => {
    const { roomName, username, adminPassword, joiningId, duration, apiKey } = data;
    
    console.log(`Creating room: ${roomName}`);
    
    // Generate unique room ID
    const roomId = `${roomName}-${Date.now()}`;
    
    // Create room
    const room = new Room(roomId, roomName, adminPassword, joiningId, duration, apiKey);
    rooms.set(roomId, room);
    
    // Add creator as admin
    socket.join(roomId);
    socket.roomId = roomId;
    const userInfo = room.addAdmin(socket.id, username);
    socket.userRole = 'admin';
    socket.username = username;
    
    // Send room created confirmation
    socket.emit('room-created', {
      roomId: roomId,
      roomName: roomName,
      role: 'admin',
      username: username,
      ...room.getState()
    });
    
    console.log(`Room ${roomId} created by ${username}`);
  });

  // Join room
  socket.on('join-room', (data) => {
    const { roomName, joiningId, adminPassword, username } = data;
    
    console.log(`${username} attempting to join room: ${roomName}`);
    
    // Find room by name and joining ID
    let targetRoom = null;
    let targetRoomId = null;
    
    for (const [roomId, room] of rooms.entries()) {
      if (room.roomName === roomName && room.joiningId === joiningId) {
        if (!room.hasExpired()) {
          targetRoom = room;
          targetRoomId = roomId;
          break;
        }
      }
    }
    
    if (!targetRoom) {
      socket.emit('join-error', {
        message: 'Room not found or expired. Please check room name and joining ID.'
      });
      return;
    }
    
    // Check if joining as admin or normal user
    const isAdmin = adminPassword && adminPassword === targetRoom.adminPassword;
    
    socket.join(targetRoomId);
    socket.roomId = targetRoomId;
    socket.username = username;
    
    let userInfo;
    if (isAdmin) {
      userInfo = targetRoom.addAdmin(socket.id, username);
      socket.userRole = 'admin';
    } else {
      userInfo = targetRoom.addNormalUser(socket.id, username);
      socket.userRole = 'user';
    }
    
    // Send room state to the new user
    socket.emit('room-joined', {
      roomId: targetRoomId,
      role: userInfo.role,
      username: username,
      ...targetRoom.getState()
    });
    
    // Notify all users in room
    io.to(targetRoomId).emit('user-joined', {
      username: username,
      role: userInfo.role,
      adminCount: targetRoom.admins.size,
      userCount: targetRoom.normalUsers.size,
      totalUsers: targetRoom.admins.size + targetRoom.normalUsers.size
    });
    
    console.log(`${username} joined room ${targetRoomId} as ${userInfo.role}`);
  });

  // Play event (admin only)
  socket.on('play', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.isAdmin(socket.id)) {
      room.updateState(true, data.time);
      socket.to(socket.roomId).emit('play', {
        time: data.time,
        from: socket.username
      });
    } else if (room && !room.isAdmin(socket.id)) {
      socket.emit('permission-denied', {
        message: 'Only admins can control playback'
      });
    }
  });

  // Pause event (admin only)
  socket.on('pause', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.isAdmin(socket.id)) {
      room.updateState(false, data.time);
      socket.to(socket.roomId).emit('pause', {
        time: data.time,
        from: socket.username
      });
    } else if (room && !room.isAdmin(socket.id)) {
      socket.emit('permission-denied', {
        message: 'Only admins can control playback'
      });
    }
  });

  // Video change event (admin only)
  socket.on('video-change', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.isAdmin(socket.id)) {
      room.currentVideo = data.videoId;
      room.updateState(false, 0);
      socket.to(socket.roomId).emit('video-change', {
        videoId: data.videoId,
        from: socket.username
      });
    } else if (room && !room.isAdmin(socket.id)) {
      socket.emit('permission-denied', {
        message: 'Only admins can change videos'
      });
    }
  });

  // Seek event (admin only)
  socket.on('seek', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.isAdmin(socket.id)) {
      room.updateState(room.isPlaying, data.time);
      socket.to(socket.roomId).emit('seek', {
        time: data.time,
        from: socket.username
      });
    } else if (room && !room.isAdmin(socket.id)) {
      socket.emit('permission-denied', {
        message: 'Only admins can seek video'
      });
    }
  });

  // Update API key (admin only)
  socket.on('update-api-key', (data) => {
    const room = rooms.get(socket.roomId);
    if (room && room.isAdmin(socket.id)) {
      room.apiKey = data.apiKey;
      io.to(socket.roomId).emit('pro-mode-updated', {
        hasProMode: !!data.apiKey,
        message: 'PRO mode enabled for all admins'
      });
      console.log(`API key updated for room ${socket.roomId}`);
    } else if (room && !room.isAdmin(socket.id)) {
      socket.emit('permission-denied', {
        message: 'Only admins can update API key'
      });
    }
  });

  // Sync request
  socket.on('request-sync', () => {
    const room = rooms.get(socket.roomId);
    if (room) {
      socket.emit('sync-state', room.getState());
    }
  });

  // Request remaining time
  socket.on('request-time', () => {
    const room = rooms.get(socket.roomId);
    if (room) {
      socket.emit('time-update', {
        remainingTime: room.getRemainingTime()
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        const result = room.removeUser(socket.id);
        
        // Notify remaining users
        io.to(socket.roomId).emit('user-left', {
          username: socket.username,
          role: socket.userRole,
          adminCount: room.admins.size,
          userCount: room.normalUsers.size,
          totalUsers: result.totalUsers,
          noAdminWarning: result.wasAdmin && result.remainingAdmins === 0
        });
        
        console.log(`${socket.username} left room ${socket.roomId}`);
      }
    }
  });

  // Handle errors
  socket.on('error', (error) => {
    console.error('Socket error:', error);
  });
});

// Periodic cleanup of expired rooms
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (room.hasExpired()) {
      console.log(`Cleaning up expired room: ${roomId}`);
      room.destroyRoom('duration_expired');
    }
  }
}, 60 * 1000); // Check every minute

// API Routes
app.get('/api/rooms', (req, res) => {
  const roomList = Array.from(rooms.values()).map(room => ({
    roomId: room.roomId,
    roomName: room.roomName,
    adminCount: room.admins.size,
    userCount: room.normalUsers.size,
    totalUsers: room.admins.size + room.normalUsers.size,
    currentVideo: room.currentVideo,
    remainingTime: room.getRemainingTime(),
    hasProMode: !!room.apiKey
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
  
  // Destroy all rooms
  for (const [roomId, room] of rooms.entries()) {
    room.destroyRoom('server_shutdown');
  }
  
  http.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

module.exports = { app, io };
