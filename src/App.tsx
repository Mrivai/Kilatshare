/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { 
  Monitor, 
  Smartphone, 
  Laptop, 
  File, 
  Upload, 
  Download, 
  CheckCircle, 
  AlertCircle,
  Share2,
  Trash2,
  Clock,
  ChevronRight,
  Loader2
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Types ---

interface Peer {
  id: string;
  type: 'desktop' | 'mobile';
  name: string;
}

interface Transfer {
  id: string;
  fileName: string;
  fileSize: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'failed';
  type: 'sender' | 'receiver';
  peerId: string;
}

// --- Utils ---

const CHUNK_SIZE = 16384; // 16KB

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const getDeviceType = () => {
  const ua = navigator.userAgent;
  if (/(tablet|ipad|playbook|silk)|(android(?!.*mobi))/i.test(ua)) return 'mobile';
  if (/Mobile|Android|iP(hone|od)|IEMobile|BlackBerry|Kindle|Silk-Accelerated|(hpw|web)OS|Opera M(obi|ini)/i.test(ua)) return 'mobile';
  return 'desktop';
};

const getDeviceName = () => {
  // Rough estimation of device name based on UA
  const platform = navigator.platform;
  const type = getDeviceType() === 'mobile' ? 'Mobile' : 'PC';
  return `${platform} ${type}`;
};

export default function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [peers, setPeers] = useState<Peer[]>([]);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [myId, setMyId] = useState<string>('');
  const [isDragging, setIsDragging] = useState(false);
  
  const peerConnections = useRef<{ [key: string]: RTCPeerConnection }>({});
  const dataChannels = useRef<{ [key: string]: RTCDataChannel }>({});
  const fileBuffers = useRef<{ [key: string]: { chunks: ArrayBuffer[], receivedSize: number, totalSize: number, fileName: string } }>({});

  // Initialize Socket.io
  useEffect(() => {
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('connect', () => {
      const id = newSocket.id || '';
      setMyId(id);
      console.log('Connected to signaling server');
      
      // Send identity
      newSocket.emit('identity', {
        type: getDeviceType(),
        name: getDeviceName()
      });
    });

    newSocket.on('user-connected', (peer: Peer) => {
      setPeers(prev => {
        if (prev.find(p => p.id === peer.id)) return prev;
        return [...prev, peer];
      });
    });

    newSocket.on('user-disconnected', (id: string) => {
      setPeers(prev => prev.filter(p => p.id !== id));
      cleanupPeer(id);
    });

    newSocket.on('signal', async ({ from, signal }: { from: string, signal: any }) => {
      console.log('Received signal from', from, signal.type);
      try {
        let pc = peerConnections.current[from];
        if (!pc) {
          pc = createPeerConnection(from);
        }

        if (signal.type === 'offer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          newSocket.emit('signal', { to: from, signal: answer });
        } else if (signal.type === 'answer') {
          await pc.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === 'candidate') {
          await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (err) {
        console.error('Error handling signal:', err);
      }
    });

    return () => {
      newSocket.disconnect();
    };
  }, []);

  const cleanupPeer = (id: string) => {
    if (peerConnections.current[id]) {
      peerConnections.current[id].close();
      delete peerConnections.current[id];
    }
    if (dataChannels.current[id]) {
      dataChannels.current[id].close();
      delete dataChannels.current[id];
    }
  };

  const createPeerConnection = (peerId: string) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    pc.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.emit('signal', { to: peerId, signal: { type: 'candidate', candidate: event.candidate } });
      }
    };

    pc.ondatachannel = (event) => {
      const channel = event.channel;
      channel.bufferedAmountLowThreshold = 65536; // 64KB
      setupDataChannel(peerId, channel);
    };

    peerConnections.current[peerId] = pc;
    return pc;
  };

  const setupDataChannel = (peerId: string, channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 65536; // 64KB
    
    channel.onopen = () => console.log('Data channel open with', peerId);
    channel.onclose = () => console.log('Data channel closed with', peerId);
    
    channel.onmessage = (event) => {
      const { data } = event;
      
      if (typeof data === 'string') {
        const message = JSON.parse(data);
        if (message.type === 'file-start') {
          const { fileName, fileSize, transferId } = message;
          fileBuffers.current[transferId] = { chunks: [], receivedSize: 0, totalSize: fileSize, fileName };
          setTransfers(prev => [...prev, {
            id: transferId,
            fileName,
            fileSize,
            progress: 0,
            status: 'transferring',
            type: 'receiver',
            peerId
          }]);
        } else if (message.type === 'file-end') {
          const { transferId } = message;
          const buffer = fileBuffers.current[transferId];
          if (buffer) {
            const blob = new Blob(buffer.chunks);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = buffer.fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            
            setTransfers(prev => prev.map(t => 
              t.id === transferId ? { ...t, status: 'completed', progress: 100 } : t
            ));
            delete fileBuffers.current[transferId];
          }
        }
      } else {
        // Binary chunk
        // Note: For simplicity, we assume the latest transferId. 
        // In a real app, we might need a metadata sandwich or a separate control channel.
        const activeTransfer = transfers.find(t => t.peerId === peerId && t.status === 'transferring' && t.type === 'receiver');
        if (activeTransfer) {
          const buffer = fileBuffers.current[activeTransfer.id];
          if (buffer) {
            buffer.chunks.push(data);
            buffer.receivedSize += data.byteLength;
            const progress = Math.round((buffer.receivedSize / buffer.totalSize) * 100);
            
            setTransfers(prev => prev.map(t => 
              t.id === activeTransfer.id ? { ...t, progress } : t
            ));
          }
        }
      }
    };

    dataChannels.current[peerId] = channel;
  };

  const startTransfer = async (peerId: string, file: File) => {
    let pc = peerConnections.current[peerId];
    if (!pc) {
      pc = createPeerConnection(peerId);
      const channel = pc.createDataChannel('fileTransfer');
      channel.bufferedAmountLowThreshold = 65536; // 64KB
      setupDataChannel(peerId, channel);
      
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit('signal', { to: peerId, signal: offer });
      
      // Wait for channel to open
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (dataChannels.current[peerId]?.readyState === 'open') {
            clearInterval(interval);
            resolve();
          }
        }, 100);
      });
    }

    const channel = dataChannels.current[peerId];
    const transferId = Math.random().toString(36).substring(7);
    
    setTransfers(prev => [...prev, {
      id: transferId,
      fileName: file.name,
      fileSize: file.size,
      progress: 0,
      status: 'transferring',
      type: 'sender',
      peerId
    }]);

    // Send metadata
    channel.send(JSON.stringify({
      type: 'file-start',
      fileName: file.name,
      fileSize: file.size,
      transferId
    }));

    // Send chunks
    const reader = new FileReader();
    let offset = 0;

    const readNextChunk = () => {
      const slice = file.slice(offset, offset + CHUNK_SIZE);
      reader.readAsArrayBuffer(slice);
    };

    reader.onload = (e) => {
      if (e.target?.result instanceof ArrayBuffer) {
        channel.send(e.target.result);
        offset += e.target.result.byteLength;
        const progress = Math.round((offset / file.size) * 100);
        
        setTransfers(prev => prev.map(t => 
          t.id === transferId ? { ...t, progress } : t
        ));

        if (offset < file.size) {
            // Check bufferedAmount to avoid overwhelming the channel
            if (channel.bufferedAmount > channel.bufferedAmountLowThreshold) {
                channel.onbufferedamountlow = () => {
                    channel.onbufferedamountlow = null;
                    readNextChunk();
                };
            } else {
                readNextChunk();
            }
        } else {
          channel.send(JSON.stringify({ type: 'file-end', transferId }));
          setTransfers(prev => prev.map(t => 
            t.id === transferId ? { ...t, status: 'completed' } : t
          ));
        }
      }
    };

    readNextChunk();
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (!e.dataTransfer?.files) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0 && peers.length > 0) {
      const file = files[0] as File;
      // Send to the first available peer for "one-click" experience if only one peer exists
      if (peers.length === 1) {
        startTransfer(peers[0].id, file);
      } else {
          // In actual app, we'd open a peer selector or let user drag onto a peer icon
          alert('Seret file ke ikon perangkat tujuan untuk mengirim.');
      }
    }
  }, [peers]);

  return (
    <div className="min-h-screen bg-[#F5F5F4] text-[#1C1917] font-sans selection:bg-orange-100 p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        
        {/* Header */}
        <header className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-4xl font-bold tracking-tight text-[#0C0A09]">KilatShare</h1>
            <p className="text-[#57534E] flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              Satu Jaringan - Siap Mengirim
            </p>
          </div>
          <div className="bg-white p-3 rounded-2xl shadow-sm border border-[#E7E5E4] flex items-center gap-3">
             <div className="w-10 h-10 rounded-xl bg-orange-100 flex items-center justify-center text-orange-600">
               <Share2 size={20} />
             </div>
             <div className="hidden sm:block">
               <p className="text-xs font-semibold uppercase tracking-wider text-[#A8A29E]">ID Kamu</p>
               <p className="font-mono text-sm">{myId.substring(0, 8)}</p>
             </div>
          </div>
        </header>

        {/* Discovery Area */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              Perangkat Ditemukan
              <span className="bg-[#E7E5E4] text-[#57534E] text-xs px-2 py-0.5 rounded-full">{peers.length}</span>
            </h2>
            <button 
              onClick={() => window.location.reload()}
              className="text-sm font-medium text-orange-600 hover:text-orange-700 transition-colors"
            >
              Segarkan
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
            <AnimatePresence>
              {peers.length === 0 ? (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="col-span-full bg-white border-2 border-dashed border-[#E7E5E4] rounded-3xl p-12 flex flex-col items-center justify-center text-center space-y-4"
                >
                  <div className="w-16 h-16 rounded-full bg-[#F5F5F4] flex items-center justify-center text-[#A8A29E]">
                    <Loader2 size={32} className="animate-spin" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg">Mencari Perangkat...</h3>
                    <p className="text-[#78716C] max-w-xs mx-auto">
                      Buka KilatShare di komputer atau HP lain dalam jaringan yang sama untuk mulai mengirim.
                    </p>
                  </div>
                </motion.div>
              ) : (
                peers.map(peer => (
                  <motion.div
                    key={peer.id}
                    layoutId={peer.id}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    whileHover={{ y: -4 }}
                    className="group relative"
                  >
                    <div className="bg-white p-6 rounded-[2rem] border border-[#E7E5E4] shadow-sm hover:shadow-md transition-all flex flex-col items-center text-center space-y-4 cursor-default">
                      <div className="w-20 h-20 rounded-3xl bg-orange-50 text-orange-600 flex items-center justify-center group-hover:bg-orange-600 group-hover:text-white transition-colors duration-300">
                        {peer.type === 'desktop' ? <Monitor size={40} /> : <Smartphone size={40} />}
                      </div>
                      <div>
                        <p className="font-bold text-lg">{peer.name}</p>
                        <p className="text-xs font-mono text-[#A8A29E] mt-1">{peer.id.substring(0, 8)}</p>
                      </div>
                      
                      <div className="relative w-full pt-2">
                        <label className="block">
                          <input 
                            type="file" 
                            className="hidden" 
                            onChange={(e) => {
                              const file = e.target.files?.[0];
                              if (file) startTransfer(peer.id, file);
                            }}
                          />
                          <div className="w-full py-3 bg-[#F5F5F4] hover:bg-orange-600 hover:text-white rounded-2xl text-sm font-semibold transition-all cursor-pointer flex items-center justify-center gap-2">
                            <Upload size={16} />
                            Kirim File
                          </div>
                        </label>
                      </div>
                    </div>
                  </motion.div>
                ))
              )}
            </AnimatePresence>
          </div>
        </section>

        {/* Transfer History / Active */}
        {transfers.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold flex items-center gap-2">
              Aktivitas Transfer
              <button 
                onClick={() => setTransfers([])}
                className="ml-2 text-[#A8A29E] hover:text-[#EF4444] transition-colors"
              >
                <Trash2 size={16} />
              </button>
            </h2>
            <div className="space-y-3">
              {transfers.slice().reverse().map(transfer => (
                <div key={transfer.id} className="bg-white p-5 rounded-3xl border border-[#E7E5E4] shadow-sm flex items-center gap-4">
                  <div className={`w-12 h-12 rounded-2xl flex items-center justify-center ${transfer.type === 'sender' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
                    {transfer.type === 'sender' ? <Upload size={20} /> : <Download size={20} />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <p className="font-semibold truncate">{transfer.fileName}</p>
                      <span className="text-xs font-medium text-[#78716C]">{formatBytes(transfer.fileSize)}</span>
                    </div>
                    
                    {transfer.status === 'transferring' ? (
                      <div className="space-y-1.5">
                        <div className="h-1.5 w-full bg-[#F5F5F4] rounded-full overflow-hidden">
                          <motion.div 
                            className="h-full bg-orange-600"
                            initial={{ width: 0 }}
                            animate={{ width: `${transfer.progress}%` }}
                          />
                        </div>
                        <p className="text-[10px] font-bold text-orange-600 uppercase tracking-widest flex items-center justify-between">
                          <span>Mengirim...</span>
                          <span>{transfer.progress}%</span>
                        </p>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2 text-xs font-medium">
                        {transfer.status === 'completed' ? (
                          <span className="text-green-600 flex items-center gap-1">
                            <CheckCircle size={14} /> Berhasil
                          </span>
                        ) : (
                          <span className="text-red-600 flex items-center gap-1">
                            <AlertCircle size={14} /> Gagal
                          </span>
                        )}
                        <span className="text-[#A8A29E]">•</span>
                        <span className="text-[#A8A29E] flex items-center gap-1">
                          <Clock size={14} /> Selesai
                        </span>
                      </div>
                    )}
                  </div>
                  <div className="hidden sm:block pl-4">
                    <ChevronRight size={20} className="text-[#D6D3D1]" />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Global Drop Zone */}
        <div 
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          className={`fixed inset-4 pointer-events-none rounded-[3rem] border-4 border-dashed transition-all duration-300 z-50 flex items-center justify-center ${isDragging ? 'opacity-100 bg-orange-600/10 border-orange-600 scale-100' : 'opacity-0 scale-95'}`}
        >
          <div className="bg-white p-8 rounded-[2.5rem] shadow-2xl flex flex-col items-center gap-4">
            <div className="w-20 h-20 rounded-3xl bg-orange-100 text-orange-600 flex items-center justify-center">
              <File size={48} />
            </div>
            <p className="text-2xl font-bold text-center">Lepas file untuk mengirim ke<br/>perangkat yang tersedia</p>
          </div>
        </div>

        {/* Footer Info */}
        <footer className="pt-12 text-center space-y-2">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-[#A8A29E]">Cara Penggunaan</p>
          <p className="text-sm text-[#78716C] max-w-sm mx-auto">
            Pastikan semua perangkat terhubung ke router yang sama. Kirim file langsung tanpa kabel dan tanpa ribet.
          </p>
        </footer>
      </div>
    </div>
  );
}
