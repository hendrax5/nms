import React, { useState, useEffect, useCallback } from 'react';
import ReactFlow, { MiniMap, Controls, Background, addEdge, useNodesState, useEdgesState } from 'reactflow';
import 'reactflow/dist/style.css';

const Topology = ({ keycloak, isAdmin, onNodeClick }) => {
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [devices, setDevices] = useState([]);
  
  // UI States
  const [showAddLink, setShowAddLink] = useState(false);
  const [newLink, setNewLink] = useState({ source_id: '', target_id: '', source_interface: '', target_interface: '' });

  // Trace Path States
  const [isTracingMode, setIsTracingMode] = useState(false);
  const [traceSource, setTraceSource] = useState(null);
  const [tracePathData, setTracePathData] = useState(null);
  const [isTracing, setIsTracing] = useState(false);
  const [hoveredHopId, setHoveredHopId] = useState(null);

  const fetchData = async () => {
    try {
      const hdrs = { 'Authorization': `Bearer ${keycloak.token}` };
      const [resDev, resLinks] = await Promise.all([
        fetch('/api/devices/', { headers: hdrs }),
        fetch('/api/links/', { headers: hdrs })
      ]);
      
      const devs = await resDev.json();
      const lnks = await resLinks.json();
      
      setDevices(devs);
      
      // Map Nodes
      const initialNodes = devs.map((dev, index) => ({
        id: dev.id,
        position: { x: (index % 5) * 200 + 100, y: Math.floor(index / 5) * 150 + 100 },
        data: { 
          label: (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontWeight: 'bold', fontSize: '14px', color: '#1a1a2e' }}>{dev.hostname}</div>
              <div style={{ fontSize: '10px', color: '#4a4e69' }}>{dev.ip_address}</div>
              <div style={{ fontSize: '10px', color: '#005f73', marginTop: '4px' }}>{dev.vendor}</div>
            </div>
          ) 
        },
        style: {
          background: '#fff',
          border: '2px solid #5a189a',
          borderRadius: '8px',
          padding: '10px',
          width: 150,
          boxShadow: '0 4px 6px rgba(0,0,0,0.1)'
        }
      }));
      setNodes(initialNodes);

      // Map Edges
      const initialEdges = lnks.map(l => ({
        id: `e-${l.id}`,
        source: l.source_id,
        target: l.target_id,
        source_interface_name: l.source_interface,
        target_interface_name: l.target_interface,
        link_type: l.link_type, // Simpan tipe link
        animated: true,
        label: l.source_interface ? `${l.source_interface} ↔ ${l.target_interface}` : '',
        style: { 
          stroke: '#4a4e69', 
          strokeWidth: 2, 
          strokeDasharray: l.link_type === 'auto' ? '5,5' : 'none' 
        }
      }));
      setEdges(initialEdges);

    } catch (err) {
      console.error("Failed to load topology:", err);
    }
  };

  const [liveMetrics, setLiveMetrics] = useState({});

  useEffect(() => {
    fetchData();
    const fetchLiveMetrics = async () => {
      try {
        const hdrs = { 'Authorization': `Bearer ${keycloak.token}` };
        const res = await fetch('/api/devices/topology/live-metrics', { headers: hdrs });
        const data = await res.json();
        if (data.status === 'success') setLiveMetrics(data.data);
      } catch (err) {
        console.error("Failed to fetch topology live metrics", err);
      }
    };
    
    fetchLiveMetrics();
    const interval = setInterval(fetchLiveMetrics, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    setEdges(eds => eds.map(e => {
        if (!e.source_interface_name) return e;
        const metrics = liveMetrics[`${e.source}__${e.source_interface_name}`];
        if (!metrics) return e;

        const totalBps = (metrics.in_rate + metrics.out_rate) * 8; // bits per second
        let labelText = e.source_interface_name && e.target_interface_name 
            ? `${e.source_interface_name} ↔ ${e.target_interface_name}` 
            : e.source_interface_name || '';
        
        let bwText = '';
        if (totalBps > 1_000_000_000) bwText = `${(totalBps / 1_000_000_000).toFixed(2)} Gbps`;
        else if (totalBps > 1_000_000) bwText = `${(totalBps / 1_000_000).toFixed(2)} Mbps`;
        else if (totalBps > 1_000) bwText = `${(totalBps / 1_000).toFixed(2)} Kbps`;
        else bwText = `${totalBps.toFixed(0)} bps`;

        let color = '#10b981'; // green: < 10Mbps
        if (totalBps > 100_000_000) color = '#ef4444'; // red: > 100Mbps
        else if (totalBps > 10_000_000) color = '#f59e0b'; // orange: 10Mbps - 100Mbps

        if (tracePathData) color = e.style.stroke; // Keep trace glow color

        return {
           ...e,
           label: `${labelText} | ${bwText}`,
           style: { ...e.style, stroke: color, strokeWidth: tracePathData ? e.style.strokeWidth : (totalBps > 10_000_000 ? 3 : 2) }
        };
    }));
  }, [liveMetrics, setEdges]);
  
  const onConnect = useCallback((params) => setEdges((eds) => addEdge(params, eds)), [setEdges]);

  const executeTrace = async (sourceId, targetId) => {
      setIsTracing(true);
      setTracePathData(null);
      try {
          const res = await fetch('/api/topology/trace-path', {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${keycloak.token}`
              },
              body: JSON.stringify({ source_id: sourceId, target_id: targetId })
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.detail || "Gagal melacak jalur");
          setTracePathData(data);
      } catch (err) {
          alert('Trace Failed: ' + err.message);
      } finally {
          setIsTracing(false);
      }
  };

  useEffect(() => {
     if (!tracePathData && !traceSource) {
         setNodes(nds => nds.map(n => ({...n, style: {...n.style, opacity: 1, boxShadow: '0 4px 6px rgba(0,0,0,0.1)'}})));
         setEdges(eds => eds.map(e => ({...e, style: {...e.style, opacity: 1}, animated: true})));
         return;
     }

     if (traceSource && !tracePathData) {
         setNodes(nds => nds.map(n => ({
             ...n, style: { ...n.style, opacity: n.id === traceSource ? 1 : 0.4, boxShadow: n.id === traceSource ? '0 0 20px #10b981' : 'none' }
         })));
         return;
     }

     if (tracePathData) {
         const { forward, reverse, is_symmetric } = tracePathData;
         const allPathNodes = new Set([...forward, ...reverse]);
         
         setNodes(nds => nds.map(n => {
             let opacity = allPathNodes.has(n.id) ? 1 : 0.2;
             let shadow = allPathNodes.has(n.id) ? '0 0 20px #eab308' : 'none';
             
             if (hoveredHopId) {
                 if (n.id === hoveredHopId) {
                     opacity = 1;
                     shadow = '0 0 35px #ec4899'; // Magenta intense glow
                 } else {
                     opacity = 0.1; // dim others
                 }
             }

             return {
                 ...n, 
                 style: { ...n.style, opacity, boxShadow: shadow, transition: 'all 0.3s ease' }
             };
         }));

         const getEdgePairs = (arr) => {
             const pairs = [];
             for(let i=0; i<arr.length-1; i++) pairs.push([arr[i], arr[i+1]]);
             return pairs;
         };
         const fwdPairs = getEdgePairs(forward);
         const revPairs = getEdgePairs(reverse);

         const isPairMatch = (e, pair) => (e.source === pair[0] && e.target === pair[1]) || (e.source === pair[1] && e.target === pair[0]);

         setEdges(eds => eds.map(e => {
             let isFwd = fwdPairs.some(p => isPairMatch(e, p));
             let isRev = revPairs.some(p => isPairMatch(e, p));

             if (!isFwd && !isRev) return { ...e, style: { ...e.style, opacity: 0.1 } };

             let color = '#0ea5e9'; // Blue
             if (is_symmetric) color = '#eab308'; // Gold
             else if (isRev && !isFwd) color = '#f97316'; // Orange
             else if (isRev && isFwd) color = '#eab308'; 

             return {
                 ...e, animated: true, style: { ...e.style, opacity: 1, stroke: color, strokeWidth: 4, strokeDasharray: 'none' }
             }
         }));
     }
  }, [tracePathData, traceSource, hoveredHopId, setNodes, setEdges]);

  const handleAddLinkSubmit = async (e) => {
    e.preventDefault();
    if (!newLink.source_id || !newLink.target_id) return alert("Source dan Target wajib diisi");
    if (newLink.source_id === newLink.target_id) return alert("Tidak bisa koneksi ke node sendiri");

    try {
      const res = await fetch('/api/links/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keycloak.token}`
        },
        body: JSON.stringify(newLink)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Gagal membuat tautan.");
      setShowAddLink(false);
      fetchData(); // Reload data
    } catch (err) {
      alert(err.message);
    }
  };

  const handleEdgeClick = async (event, edge) => {
    event.preventDefault();
    if (!isAdmin) return; // Read-only for viewers

    if(window.confirm("Hapus interkoneksi ini?")) {
      const linkId = edge.id.replace('e-','');
      await fetch(`/api/links/${linkId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${keycloak.token}` }
      });
      fetchData();
    }
  };

  return (
    <div style={{ width: '100%', height: 'calc(100vh - 150px)', background: 'rgba(0,0,0,0.1)' }}>
      <div style={{ position: 'absolute', top: '100px', right: '30px', zIndex: 4, display: 'flex', gap: '10px' }}>
        <button 
          className="btn-outline" 
          onClick={() => {
              setIsTracingMode(!isTracingMode);
              setTracePathData(null);
              setTraceSource(null);
          }} 
          style={{ background: isTracingMode ? '#10b981' : '#333', color: '#fff' }}>
          {isTracing ? '⏳ Tracing...' : (isTracingMode ? '🎯 Select Target Node...' : '🗺️ Trace Path')}
        </button>
        {isAdmin && <button className="btn-primary" onClick={() => setShowAddLink(true)}>🔗 Add Link</button>}
        <button className="btn-outline" onClick={fetchData} style={{ background: '#333' }}>🔄 Refresh Map</button>
      </div>
      
      {tracePathData && (
          <div style={{ position: 'absolute', top: '100px', left: '30px', zIndex: 10, background: '#1a1a2e', width: '380px', maxHeight: 'calc(100vh - 150px)', overflowY: 'auto', padding: '20px', borderRadius: '12px', border: tracePathData.is_symmetric ? '2px solid #eab308' : '2px solid #ef4444', color: '#fff', boxShadow: '0 10px 25px rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', gap: '15px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0, fontSize: '18px', color: tracePathData.is_symmetric ? '#eab308' : '#ef4444' }}>
                      <span style={{ marginRight: '8px' }}>🕵️‍♂️</span> 
                      {tracePathData.is_symmetric ? 'SYMMETRIC PATH' : 'ASYMMETRIC PATH'}
                  </h3>
                  <button className="btn-outline" style={{ padding: '4px 10px', height: 'auto', background: 'transparent', borderColor: '#4a4e69', color: '#aaa', fontSize: '12px' }} onClick={() => { setTracePathData(null); setHoveredHopId(null); }}>Tutup</button>
              </div>

              <div style={{ display: 'flex', gap: '15px' }}>
                  {/* Forward Stepper */}
                  <div style={{ flex: 1 }}>
                      <h4 style={{ margin: '0 0 10px 0', color: '#0ea5e9', fontSize: '13px', borderBottom: '1px solid #333', paddingBottom: '5px' }}>🔵 Forward Path</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                          {tracePathData.forward.map((hop, idx) => {
                              const dev = devices.find(d => d.id === hop || d.ip_address === hop);
                              const name = dev ? dev.hostname : "Unknown Router";
                              const ip = dev ? dev.ip_address : hop; // Selalu tampilkan IP aktual
                              return (
                                  <div key={`fwd-${idx}`} style={{ display: 'flex', gap: '10px' }} onMouseEnter={() => setHoveredHopId(hop)} onMouseLeave={() => setHoveredHopId(null)}>
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#0ea5e9', marginTop: '6px', boxShadow: hoveredHopId === hop ? '0 0 10px #0ea5e9' : 'none' }}></div>
                                          {idx < tracePathData.forward.length - 1 && <div style={{ width: '2px', height: '40px', background: '#334155' }}></div>}
                                      </div>
                                      <div style={{ paddingBottom: idx < tracePathData.forward.length - 1 ? '15px' : '0', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}>
                                          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px', textTransform: 'uppercase' }}>Hop {idx + 1}</div>
                                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: hoveredHopId === hop ? '#ec4899' : '#fff', transition: 'color 0.2s' }}>{name}</div>
                                          <div style={{ fontSize: '11px', color: '#4ade80', fontFamily: 'monospace', marginTop: '2px' }}>{ip}</div>
                                      </div>
                                  </div>
                              );
                          })}
                      </div>
                  </div>

                  <div style={{ width: '1px', background: '#333' }}></div>

                  {/* Return Stepper */}
                  <div style={{ flex: 1 }}>
                      <h4 style={{ margin: '0 0 10px 0', color: '#f97316', fontSize: '13px', borderBottom: '1px solid #333', paddingBottom: '5px' }}>🟠 Return Path</h4>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0' }}>
                          {[...tracePathData.reverse].reverse().map((hop, invertedIdx) => {
                              const originalIdx = tracePathData.reverse.length - 1 - invertedIdx;
                              const dev = devices.find(d => d.id === hop || d.ip_address === hop);
                              const name = dev ? dev.hostname : "Unknown Router";
                              const ip = dev ? dev.ip_address : hop;
                              return (
                                  <div key={`rev-${originalIdx}`} style={{ display: 'flex', gap: '10px' }} onMouseEnter={() => setHoveredHopId(hop)} onMouseLeave={() => setHoveredHopId(null)}>
                                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '20px' }}>
                                          <div style={{ width: '12px', height: '12px', borderRadius: '50%', background: '#f97316', marginTop: '6px', boxShadow: hoveredHopId === hop ? '0 0 10px #f97316' : 'none' }}></div>
                                          {invertedIdx < tracePathData.reverse.length - 1 && <div style={{ width: '2px', height: '40px', background: '#334155' }}></div>}
                                      </div>
                                      <div style={{ paddingBottom: invertedIdx < tracePathData.reverse.length - 1 ? '15px' : '0', cursor: 'pointer', display: 'flex', flexDirection: 'column' }}>
                                          <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '2px', textTransform: 'uppercase' }}>Hop {originalIdx + 1}</div>
                                          <div style={{ fontSize: '13px', fontWeight: 'bold', color: hoveredHopId === hop ? '#ec4899' : '#fff', transition: 'color 0.2s' }}>{name}</div>
                                          <div style={{ fontSize: '11px', color: '#4ade80', fontFamily: 'monospace', marginTop: '2px' }}>{ip}</div>
                                      </div>
                                  </div>
                              );
                          })}
                      </div>
                  </div>
              </div>

              {/* Raw Trace Logs */}
              {(tracePathData.forward_raw || tracePathData.reverse_raw) && (
                  <div style={{ marginTop: '20px', background: '#0f172a', padding: '12px', borderRadius: '6px', fontSize: '11px', color: '#94a3b8', fontFamily: 'monospace', maxHeight: '180px', overflowY: 'auto', whiteSpace: 'pre-wrap', border: '1px solid #334155', boxShadow: 'inset 0 2px 4px rgba(0,0,0,0.5)' }}>
                      {tracePathData.forward_raw && (
                          <div style={{ marginBottom: tracePathData.reverse_raw ? '12px' : '0' }}>
                              <div style={{ color: '#0ea5e9', marginBottom: '5px', fontWeight: 'bold', fontSize: '12px' }}>&gt; Forward Trace Payload</div>
                              {tracePathData.forward_raw}
                          </div>
                      )}
                      {tracePathData.reverse_raw && (
                          <div>
                              <div style={{ color: '#f97316', marginBottom: '5px', fontWeight: 'bold', fontSize: '12px' }}>&gt; Return Trace Payload</div>
                              {tracePathData.reverse_raw}
                          </div>
                      )}
                  </div>
              )}
          </div>
      )}

      {showAddLink && (
        <div style={{ position: 'absolute', top: '150px', right: '30px', zIndex: 10, background: '#1a1a2e', padding: '20px', borderRadius: '8px', border: '1px solid #4a4e69', boxShadow: '0 8px 16px rgba(0,0,0,0.5)' }}>
          <h3 style={{ color: '#fff', marginTop: 0 }}>Add New Link</h3>
          <form onSubmit={handleAddLinkSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ color: '#aaa', fontSize: '12px' }}>Source Node</label>
              <select value={newLink.source_id} onChange={e => setNewLink({...newLink, source_id: e.target.value})} style={{ padding: '8px', borderRadius: '4px' }}>
                <option value="">-- Pilih Source --</option>
                {devices.map(d => <option key={d.id} value={d.id}>{d.hostname} ({d.ip_address})</option>)}
              </select>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ color: '#aaa', fontSize: '12px' }}>Source Interface (Opt)</label>
              <input type="text" placeholder="e.g. Gig0/1" value={newLink.source_interface} onChange={e => setNewLink({...newLink, source_interface: e.target.value})} style={{ padding: '8px', borderRadius: '4px' }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ color: '#aaa', fontSize: '12px' }}>Target Node</label>
              <select value={newLink.target_id} onChange={e => setNewLink({...newLink, target_id: e.target.value})} style={{ padding: '8px', borderRadius: '4px' }}>
                <option value="">-- Pilih Target --</option>
                {devices.map(d => <option key={d.id} value={d.id}>{d.hostname} ({d.ip_address})</option>)}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <label style={{ color: '#aaa', fontSize: '12px' }}>Target Interface (Opt)</label>
              <input type="text" placeholder="e.g. Gig0/2" value={newLink.target_interface} onChange={e => setNewLink({...newLink, target_interface: e.target.value})} style={{ padding: '8px', borderRadius: '4px' }} />
            </div>
            
            <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
              <button type="submit" className="btn-primary" style={{ flex: 1 }}>Save</button>
              <button type="button" className="btn-outline" onClick={() => setShowAddLink(false)} style={{ flex: 1 }}>Cancel</button>
            </div>
          </form>
        </div>
      )}

      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgeClick={handleEdgeClick}
        onNodeClick={(event, node) => {
          if (isTracingMode) {
              if (!traceSource) {
                  setTraceSource(node.id);
                  setTracePathData(null);
                  return;
              }
              if (traceSource === node.id) {
                  setTraceSource(null); // Cancel
                  return;
              }
              executeTrace(traceSource, node.id);
              setTraceSource(null);
              setIsTracingMode(false); // Auto toggle off after selection
              return;
          }

          const dev = devices.find(d => d.id === node.id);
          if (dev && onNodeClick) {
            onNodeClick(dev);
          }
        }}
        fitView
      >
        <Background color="#fff" gap={16} />
        <MiniMap />
        <Controls />
      </ReactFlow>
    </div>
  );
};

export default Topology;
