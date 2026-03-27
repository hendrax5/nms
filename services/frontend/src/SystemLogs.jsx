import React, { useState, useEffect, useMemo, useRef } from 'react';

const SystemLogs = ({ token }) => {
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters & Toggles State
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedIp, setSelectedIp] = useState('ALL');
  const [activeSeverities, setActiveSeverities] = useState({
    CRITICAL: true,
    WARNING: true,
    INFO: true
  });
  const [isPaused, setIsPaused] = useState(false);

  // Using a ref to track pause state inside setInterval without wiping the interval
  const isPausedRef = useRef(isPaused);
  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  const fetchLogs = () => {
    if (isPausedRef.current && logs.length > 0) return; // Skip fetch if paused and already initialized

    fetch('/api/devices/logs/syslog?limit=500', {
      headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(res => res.json())
    .then(data => {
      if (data.status === 'success') setLogs(data.data);
      setLoading(false);
    })
    .catch(err => {
      console.error("Failed to fetch syslogs", err);
      setLoading(false);
    });
  };

  useEffect(() => {
    fetchLogs();
    const interval = setInterval(fetchLogs, 5000);
    return () => clearInterval(interval);
  }, [token]);

  // Utility Functions
  const getSeverityGroup = (sev) => {
    if (sev <= 3) return 'CRITICAL';
    if (sev === 4) return 'WARNING';
    return 'INFO';
  };

  const getSeverityBg = (sev) => {
    if (sev <= 3) return 'rgba(239, 68, 68, 0.15)'; 
    if (sev === 4) return 'rgba(245, 158, 11, 0.15)'; 
    return 'rgba(59, 130, 246, 0.1)'; 
  };

  const getSeverityColor = (sev) => {
    if (sev <= 3) return '#ef4444'; 
    if (sev === 4) return '#f59e0b';
    return '#60a5fa';
  };

  // Derived States (Memoized Calculations)
  const uniqueIps = useMemo(() => {
    const ips = new Set(logs.map(lg => lg.source_ip));
    return ['ALL', ...Array.from(ips)];
  }, [logs]);

  const stats = useMemo(() => {
    let crit = 0, warn = 0, info = 0;
    logs.forEach(lg => {
       const grp = getSeverityGroup(lg.severity);
       if(grp === 'CRITICAL') crit++;
       else if(grp === 'WARNING') warn++;
       else info++;
    });
    return { crit, warn, info, total: logs.length };
  }, [logs]);

  const filteredLogs = useMemo(() => {
    return logs.filter(lg => {
       const group = getSeverityGroup(lg.severity);
       if (!activeSeverities[group]) return false;
       if (selectedIp !== 'ALL' && lg.source_ip !== selectedIp) return false;
       if (searchTerm) {
          const term = searchTerm.toLowerCase();
          if (!lg.message.toLowerCase().includes(term) && !lg.source_ip.includes(term)) {
             return false;
          }
       }
       return true;
    });
  }, [logs, activeSeverities, selectedIp, searchTerm]);

  const toggleSeverity = (group) => {
    setActiveSeverities(prev => ({ ...prev, [group]: !prev[group] }));
  };

  return (
    <div style={{ padding: '20px', color: '#f8fafc', height: '100%', display: 'flex', flexDirection: 'column' }}>
      
      {/* Header & HUD */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
           <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '10px', fontWeight: 600 }}>
             <span style={{ fontSize: '24px' }}>📜</span> Syslog Pro Observer
           </h2>
           <div style={{ fontSize: '13px', color: '#94a3b8', marginTop: '6px' }}>Network Event Horizon & Anomalies Target</div>
        </div>

        {/* Global Mini-Stats HUD */}
        <div style={{ display: 'flex', gap: '12px', background: 'rgba(0,0,0,0.3)', padding: '8px 16px', borderRadius: '12px', border: '1px solid #334155' }}>
           <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#ef4444' }}></div>
              <span style={{ color: '#ef4444', fontWeight: 'bold' }}>{stats.crit}</span>
              <span style={{ color: '#64748b', fontSize: '12px' }}>CRITS</span>
           </div>
           <div style={{ borderLeft: '1px solid #334155' }}></div>
           <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#f59e0b' }}></div>
              <span style={{ color: '#f59e0b', fontWeight: 'bold' }}>{stats.warn}</span>
              <span style={{ color: '#64748b', fontSize: '12px' }}>WARNS</span>
           </div>
           <div style={{ borderLeft: '1px solid #334155' }}></div>
           <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: '#60a5fa' }}></div>
              <span style={{ color: '#60a5fa', fontWeight: 'bold' }}>{stats.info}</span>
              <span style={{ color: '#64748b', fontSize: '12px' }}>INFOS</span>
           </div>
           <div style={{ borderLeft: '1px solid #334155' }}></div>
           <div style={{ color: '#94a3b8', fontSize: '12px', display: 'flex', alignItems: 'center' }}>Total: {stats.total}</div>
        </div>
      </div>

      {/* Control Panel (Filters & Actions) */}
      <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '8px 8px 0 0', padding: '12px 16px', display: 'flex', gap: '16px', alignItems: 'center', flexWrap: 'wrap' }}>
        
        {/* Play/Pause Toggle */}
        <button 
          onClick={() => setIsPaused(!isPaused)}
          style={{ padding: '8px 16px', background: isPaused ? 'rgba(239, 68, 68, 0.2)' : 'rgba(16, 185, 129, 0.2)', border: `1px solid ${isPaused ? '#ef4444' : '#10b981'}`, color: isPaused ? '#fca5a5' : '#6ee7b7', borderRadius: '6px', cursor: 'pointer', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px', transition: 'all 0.3s' }}>
          {isPaused ? '▶ RESUME STREAM' : '⏸ PAUSE STREAM'}
        </button>

        <div style={{ width: '1px', background: '#334155', height: '24px' }}></div>

        {/* Severity Pills */}
        <div style={{ display: 'flex', gap: '8px' }}>
           <button onClick={() => toggleSeverity('CRITICAL')} style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid #ef4444', background: activeSeverities['CRITICAL'] ? '#ef4444' : 'transparent', color: activeSeverities['CRITICAL'] ? '#fff' : '#ef4444', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>CRITICAL</button>
           <button onClick={() => toggleSeverity('WARNING')} style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid #f59e0b', background: activeSeverities['WARNING'] ? '#f59e0b' : 'transparent', color: activeSeverities['WARNING'] ? '#fff' : '#f59e0b', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>WARNING</button>
           <button onClick={() => toggleSeverity('INFO')} style={{ padding: '6px 12px', borderRadius: '16px', border: '1px solid #60a5fa', background: activeSeverities['INFO'] ? '#60a5fa' : 'transparent', color: activeSeverities['INFO'] ? '#fff' : '#60a5fa', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', transition: '0.2s' }}>INFO / DEBUG</button>
        </div>

        <div style={{ flex: 1 }}></div>

        {/* Filters */}
        <select value={selectedIp} onChange={e => setSelectedIp(e.target.value)} style={{ padding: '8px 12px', background: 'rgba(0,0,0,0.2)', border: '1px solid #475569', color: '#e2e8f0', borderRadius: '6px', outline: 'none' }}>
           <option value="ALL">🌐 All Target Entities</option>
           {uniqueIps.filter(ip => ip !== 'ALL').map(ip => (
              <option key={ip} value={ip}>{ip}</option>
           ))}
        </select>
        
        <div style={{ position: 'relative' }}>
          <span style={{ position: 'absolute', left: '10px', top: '8px', filter: 'grayscale(100%) opacity(50%)' }}>🔍</span>
          <input 
            type="text" 
            placeholder="Regex / Payload Search..." 
            value={searchTerm} 
            onChange={e => setSearchTerm(e.target.value)}
            style={{ padding: '8px 12px 8px 32px', background: 'rgba(0,0,0,0.2)', border: '1px solid #475569', color: '#fff', borderRadius: '6px', outline: 'none', width: '220px' }}
          />
        </div>

      </div>

      {/* Main Terminal List */}
      <div style={{ flex: 1, overflow: 'hidden', background: '#0f172a', borderRadius: '0 0 8px 8px', border: '1px solid #334155', borderTop: 'none', display: 'flex', flexDirection: 'column', boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)' }}>
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
          {loading && logs.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>Establishing UDP socket stream...</div>
          ) : filteredLogs.length === 0 ? (
             <div style={{ textAlign: 'center', padding: '40px', color: '#64748b' }}>No syslogs matching the current filters.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {filteredLogs.map((log) => (
                <div key={log.id} style={{ display: 'flex', padding: '12px 8px', background: getSeverityBg(log.severity), borderRadius: '4px', fontSize: '13px', borderLeft: `3px solid ${getSeverityColor(log.severity)}`, alignItems: 'flex-start', transition: 'background 0.2s', cursor: 'default' }} onMouseEnter={(e) => e.currentTarget.style.filter = 'brightness(1.2)'} onMouseLeave={(e) => e.currentTarget.style.filter = 'brightness(1)'}>
                  <div style={{ width: '160px', color: '#94a3b8', fontFamily: 'monospace', fontSize: '12px' }}>
                     {new Date(log.timestamp).toLocaleString('en-GB')}
                  </div>
                  <div style={{ width: '130px', color: '#38bdf8', fontFamily: 'monospace', fontWeight: 'bold' }}>
                     {log.source_ip}
                  </div>
                  <div style={{ width: '120px', color: getSeverityColor(log.severity), fontWeight: 'bold', fontSize: '11px', letterSpacing: '0.5px' }}>
                     {getSeverityGroup(log.severity)} ({log.severity})
                  </div>
                  <div style={{ flex: 1, color: '#e2e8f0', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: '1.4' }}>
                     {log.message}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SystemLogs;
