import React, { useState, useEffect } from 'react';
import Keycloak from 'keycloak-js';
import Topology from './Topology';
import SystemLogs from './SystemLogs';
import ReportsEngine from './ReportsEngine';
import './index.css';

// Inisialisasi Keycloak Client Config
const keycloak = new Keycloak({
  url: window.location.origin + '/auth', 
  realm: 'nms_realm',
  clientId: 'react_frontend'
});

function MainApp() {
  const [keycloakAuth, setKeycloakAuth] = useState({ authenticated: false, token: null });
  const [devices, setDevices] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [isEditMode, setIsEditMode] = useState(false);
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Dashboard Aggregated State
  const [topMetrics, setTopMetrics] = useState({ top_cpu: [], top_latency: [] });

  
  // Embedded Analytics State
  const [metricsDevice, setMetricsDevice] = useState(null);
  const [telemetryTab, setTelemetryTab] = useState('ping'); // 'ping' or 'advanced'
  const [timeRange, setTimeRange] = useState('1h');
  const [deviceInterfaces, setDeviceInterfaces] = useState([]);
  const [selectedInterface, setSelectedInterface] = useState(null);
  const [interfacesLoading, setInterfacesLoading] = useState(false);

  const [systemSettings, setSystemSettings] = useState({
    polling_interval_sec: 300,
    smtp_host: '',
    smtp_port: '',
    smtp_user: '',
    smtp_pass: '',
    alert_webhook_url: ''
  });
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [activeAlarms, setActiveAlarms] = useState([]);

  useEffect(() => {
    if (activeTab === 'settings' && keycloakAuth.authenticated) {
      fetch('/api/settings', { headers: { 'Authorization': `Bearer ${keycloakAuth.token}` } })
        .then(res => res.json())
        .then(data => setSystemSettings(data))
        .catch(err => console.error("Error fetching settings:", err));
    }
    if (activeTab === 'alarms' && keycloakAuth.authenticated) {
      const fetchAlarms = () => {
        fetch('/api/alarms', { headers: { 'Authorization': `Bearer ${keycloakAuth.token}` } })
          .then(res => res.json())
          .then(data => setActiveAlarms(data))
          .catch(err => console.error("Error fetching alarms:", err));
      };
      fetchAlarms();
      const intv = setInterval(fetchAlarms, 10000);
      return () => clearInterval(intv);
    }
  }, [activeTab, keycloakAuth.authenticated, keycloakAuth.token]);

  const handleSaveSettings = (e) => {
    e.preventDefault();
    setIsSavingSettings(true);
    fetch('/api/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keycloakAuth.token}`
      },
      body: JSON.stringify(systemSettings)
    }).then(res => res.json()).then(() => {
      alert("System Settings Saved!");
    }).finally(() => setIsSavingSettings(false));
  };

  const handleAckAlarm = (alarmId) => {
    fetch(`/api/alarms/${alarmId}/ack`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${keycloakAuth.token}` }
    }).then(() => {
      setActiveAlarms(prev => prev.map(a => a.alarm_id === alarmId ? {...a, status: 'Acknowledged', acknowledged_by: keycloakAuth.tokenParsed?.preferred_username || 'admin'} : a));
    });
  };

  useEffect(() => {
    if (metricsDevice && telemetryTab === 'advanced' && keycloakAuth.authenticated) {
      setDeviceInterfaces([]);
      setSelectedInterface(null);
      setInterfacesLoading(true);
      fetch(`/api/devices/${metricsDevice.id}/interfaces`, {
        headers: { 'Authorization': `Bearer ${keycloakAuth.token}` }
      })
      .then(res => {
         if(!res.ok) throw new Error("API Error");
         return res.json();
      })
      .then(data => {
         setDeviceInterfaces(data || []);
         setInterfacesLoading(false);
      })
      .catch(err => {
         console.error("Failed to fetch interfaces", err);
         setInterfacesLoading(false);
      });
    }
  }, [metricsDevice, telemetryTab, keycloakAuth.authenticated, keycloakAuth.token]);

  const handleToggleMonitoring = (interfaceName, currentStatus) => {
    const newStatus = !currentStatus;
    setDeviceInterfaces(prev => prev.map(iface => 
      iface.name === interfaceName ? { ...iface, is_monitored: newStatus } : iface
    ));

    fetch(`/api/devices/${metricsDevice.id}/sensors`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${keycloakAuth.token}` 
      },
      body: JSON.stringify({ interface_name: interfaceName, is_monitored: newStatus })
    })
    .then(async res => {
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Sensor toggle failed');
      }
    })
    .catch(err => {
      alert("Error updating sensor: " + err.message);
      setDeviceInterfaces(prev => prev.map(iface => 
        iface.name === interfaceName ? { ...iface, is_monitored: currentStatus } : iface
      ));
    });
  };

  // NCM States
  const [selectedDeviceForNcm, setSelectedDeviceForNcm] = useState('');
  const [configHistory, setConfigHistory] = useState([]);
  const [compareIds, setCompareIds] = useState([]);
  const [diffResult, setDiffResult] = useState(null);
  const [complianceRule, setComplianceRule] = useState('');
  const [complianceResult, setComplianceResult] = useState(null);
  const [viewConfigData, setViewConfigData] = useState(null);
  const [copyStatus, setCopyStatus] = useState(null);

  const handleCopy = (text, id) => {
    navigator.clipboard.writeText(text);
    setCopyStatus(id);
    setTimeout(() => setCopyStatus(null), 2000);
  };

  const renderDiffContent = (diffText) => {
    return diffText.split('\n').map((line, idx) => {
      let bgColor = 'transparent';
      let color = '#e5e7eb';
      if (line.startsWith('-') && !line.startsWith('---')) {
         bgColor = 'rgba(255, 99, 132, 0.15)'; 
         color = '#f87171'; 
      } else if (line.startsWith('+') && !line.startsWith('+++')) {
         bgColor = 'rgba(16, 185, 129, 0.15)'; 
         color = '#34d399'; 
      } else if (line.startsWith('@@')) {
         color = '#60a5fa'; 
      }
      
      return (
        <div key={idx} style={{ backgroundColor: bgColor, color: color, padding: '2px 12px', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', fontSize: '13px' }}>
          {line}
        </div>
      );
    });
  };
  
  const [newDev, setNewDev] = useState({ 
    id: '', hostname: '', ip_address: '', type: 'Router', vendor: 'Cisco', 
    snmp_community: 'public', ssh_user: '', ssh_pass: '', ssh_port: 22, thresholds: { cpu: 80, ping: 150 }
  });

  const isRun = React.useRef(false);

  useEffect(() => {
    if (isRun.current) return;
    isRun.current = true;
    
    // 1. Inisialisasi Koneksi ke IAM Keycloak saat komponen mount
    keycloak.init({ onLoad: 'login-required', checkLoginIframe: false }).then(authenticated => {
      setKeycloakAuth({ authenticated, token: keycloak.token });
    }).catch(err => {
      console.error("Keycloak Init Error:", err);
    });
  }, []);

  const fetchDevices = () => {
    fetch('/api/devices/', {
      headers: {
        'Authorization': `Bearer ${keycloak.token}`
      }
    })
      .then(res => {
        if (!res.ok) throw new Error("Unauthorized or Backend Error");
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) {
          const formatted = data.map(dev => ({
            id: dev.id, name: dev.hostname, ip: dev.ip_address, type: dev.type, vendor: dev.vendor,
            snmp_community: dev.snmp_community, snmp_port: dev.snmp_port, 
            ssh_user: dev.ssh_user || '', ssh_pass: dev.ssh_pass || '',
            ssh_port: dev.ssh_port || 22, ssh_protocol: dev.ssh_protocol || 'ssh',
            thresholds: dev.thresholds || { cpu: 80, ping: 150 },
            status: dev.status || 'UP', latency: '< 1ms'
          }));
          setDevices(formatted);
        }
      })
      .catch(err => console.error('Gagal fetch data perangkat:', err));
  };

  const fetchTopMetrics = () => {
    fetch('/api/devices/dashboard/top-metrics', {
      headers: { 'Authorization': `Bearer ${keycloak.token}` }
    })
      .then(res => res.json())
      .then(data => {
         setTopMetrics({ top_cpu: data.top_cpu || [], top_latency: data.top_latency || [] });
      })
      .catch(err => console.error("Gagal fetch top metrics:", err));
  };

  useEffect(() => {
    if (keycloakAuth.authenticated) {
      fetchDevices();
      fetchTopMetrics();
      const interval = setInterval(() => {
         fetchDevices();
         fetchTopMetrics();
      }, 5000);
      return () => clearInterval(interval);
    }
  }, [keycloakAuth.authenticated]);

  const openAddModal = () => {
    setIsEditMode(false);
    setNewDev({ id: '', hostname: '', ip_address: '', type: 'Router', vendor: 'Cisco', snmp_community: 'public', snmp_port: 161, ssh_user: '', ssh_pass: '', ssh_port: 22, ssh_protocol: 'ssh', thresholds: { cpu: 80, ping: 150 } });
    setShowModal(true);
  };

  const openEditModal = (dev) => {
    setIsEditMode(true);
    setNewDev({
      id: dev.id, hostname: dev.name, ip_address: dev.ip, type: dev.type, vendor: dev.vendor,
      snmp_community: dev.snmp_community || 'public', snmp_port: dev.snmp_port || 161, 
      ssh_user: dev.ssh_user || '', ssh_pass: dev.ssh_pass || '', 
      ssh_port: dev.ssh_port || 22, ssh_protocol: dev.ssh_protocol || 'ssh',
      thresholds: dev.thresholds || { cpu: 80, ping: 150 }
    });
    setShowModal(true);
  };

  const handleSaveDevice = (e) => {
    e.preventDefault();
    let finalId = newDev.id;
    if (!isEditMode && (!finalId || finalId.trim() === '')) {
      finalId = newDev.hostname.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    }
    const finalDev = { ...newDev, id: finalId, ssh_port: parseInt(newDev.ssh_port) || 22, snmp_port: parseInt(newDev.snmp_port) || 161 };

    const endpoint = isEditMode ? `/api/devices/${finalId}` : '/api/devices/';
    const method = isEditMode ? 'PUT' : 'POST';

    fetch(endpoint, {
      method: method,
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
      body: JSON.stringify(finalDev)
    })
    .then(async (res) => {
      if (!res.ok) {
        const err = await res.json();
        alert(err.detail || "Database Error");
        return;
      }
      setShowModal(false);
      setTestResult(null);
      fetchDevices(); 
    })
    .catch(err => alert("Gagal menyimpan perangkat: " + err));
  };

  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const payload = { ...newDev, ssh_port: parseInt(newDev.ssh_port) || 22, snmp_port: parseInt(newDev.snmp_port) || 161 };
      // Backend doesn't strictly need ID for testing
      const res = await fetch('/api/devices/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${keycloak.token}`
        },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        alert("Gagal menguji koneksi: " + (data.detail || "Server Error"));
        setIsTesting(false);
        return;
      }
      setTestResult(data);
    } catch (err) {
      alert("Error contacting Test API: " + err.message);
    } finally {
      setIsTesting(false);
    }
  };

  const handleExportDevices = () => {
    if (!devices || devices.length === 0) return alert("Tidak ada perangkat untuk diekspor.");
    const headers = ["hostname", "ip_address", "vendor", "type", "ssh_user", "ssh_pass", "ssh_port", "snmp_community", "snmp_port", "ssh_protocol"];
    const rows = devices.map(d => headers.map(h => d[h] || '').join(','));
    const csvContent = "data:text/csv;charset=utf-8," + headers.join(',') + "\n" + rows.join('\n');
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute("href", encodeURI(csvContent));
    downloadAnchorNode.setAttribute("download", "nms_devices_export.csv");
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  const handleImportDevices = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const text = event.target.result;
        const lines = text.split('\n').filter(l => l.trim() !== '');
        if (lines.length < 2) throw new Error("CSV kosong atau tidak ada data baris.");
        
        const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
        const imported = [];
        for (let i = 1; i < lines.length; i++) {
          const vals = lines[i].split(',');
          let obj = {};
          headers.forEach((h, idx) => { obj[h] = vals[idx]?.trim() || ''; });
          if(obj.ip_address) imported.push(obj);
        }

        let successCount = 0;
        for (const dev of imported) {
          if(dev.ssh_port) dev.ssh_port = parseInt(dev.ssh_port);
          if(dev.snmp_port) dev.snmp_port = parseInt(dev.snmp_port);
          
          await fetch('/api/devices/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
            body: JSON.stringify(dev)
          });
          successCount++;
        }
        alert(`Berhasil mengimpor ${successCount} perangkat dari File CSV!`);
        fetchDevices();
      } catch (err) {
        alert("Gagal impor CSV: " + err.message);
      }
    };
    reader.readAsText(file);
    e.target.value = null; // reset input
  };

  const deleteDevice = (id) => {
    if (!window.confirm("Yakin hapus perangkat ini dari PostgreSQL secara permanen?")) return;
    fetch(`/api/devices/${encodeURIComponent(id)}`, { 
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${keycloak.token}`
      }
    })
      .then(() => fetchDevices())
      .catch(err => alert(err));
  };

  const doLogout = () => {
    keycloak.logout();
  };

  // --- NCM Functions ---
  const fetchConfigHistory = (deviceId) => {
    setSelectedDeviceForNcm(deviceId);
    setDiffResult(null);
    setCompareIds([]);
    setComplianceResult(null);
    setViewConfigData(null);
    fetch(`/api/config/history/${deviceId}`, { headers: { 'Authorization': `Bearer ${keycloak.token}` } })
      .then(async (res) => {
        if (!res.ok) throw new Error(await res.text());
        return res.json();
      })
      .then(data => {
        if (Array.isArray(data)) setConfigHistory(data);
        else {
          console.warn("API Histori bukan Array:", data);
          setConfigHistory([]);
        }
      })
      .catch(err => {
        console.error("Gagal fetch config history", err);
        setConfigHistory([]);
      });
  };

  const handleTriggerBackup = (deviceId) => {
    fetch(`/api/config/backup/${deviceId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${keycloak.token}` } })
      .then(res => res.json())
      .then(data => alert(data.message))
      .catch(err => alert("Gagal trigger backup: " + err))
      .finally(() => {
         // Auto-refresh config history
         if (selectedDeviceForNcm === deviceId) fetchConfigHistory(deviceId);
      });
  };

  const handleRestore = (deviceId, configId) => {
    alert("Operasi Restore dinonaktifkan sementara untuk pengujian Phase 35 (Hanya Read-Only).");
  };

  const handleCompare = () => {
    if (compareIds.length !== 2) {
      alert("Pilih tepat 2 konfigurasi untuk dibandingkan (Checklist).");
      return;
    }
    fetch(`/api/config/compare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
      body: JSON.stringify({ config_id_1: compareIds[0], config_id_2: compareIds[1] })
    })
      .then(async (res) => {
         if (!res.ok) throw new Error(await res.text());
         return res.json();
      })
      .then(data => setDiffResult(data))
      .catch(err => alert("Gagal Komparasi: " + err));
  };

  const handleComplianceCheck = () => {
    if (!selectedDeviceForNcm || !complianceRule) return;
    const rules = complianceRule.split(',').map(s => s.trim());
    fetch(`/api/devices/compliance`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
      body: JSON.stringify({ device_id: selectedDeviceForNcm, required_strings: rules })
    })
      .then(res => res.json())
      .then(data => setComplianceResult(data))
      .catch(err => alert("Gagal Compliance Check: " + err));
  };

  const toggleCompareId = (id) => {
    setCompareIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2) return [prev[1], id];
      return [...prev, id];
    });
  };

  // --- NMS Subnet Auto-Discovery ---
  const [showDiscoveryModal, setShowDiscoveryModal] = useState(false);
  const [discoveryParam, setDiscoveryParam] = useState({ subnet: '', snmp_communities: 'public, private, nms', ssh_user: '', ssh_pass: '' });
  const [discoveryResults, setDiscoveryResults] = useState(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [selectedDiscovered, setSelectedDiscovered] = useState([]);

  const handleDiscoverySubmit = (e) => {
    e.preventDefault();
    setIsDiscovering(true);
    setDiscoveryResults(null);
    setSelectedDiscovered([]);
    
    const payload = {
       subnet: discoveryParam.subnet,
       snmp_communities: discoveryParam.snmp_communities.split(',').map(s => s.trim())
    };

    fetch('/api/devices/discovery/scan', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
       body: JSON.stringify(payload)
    })
    .then(async res => {
       const data = await res.json();
       if(!res.ok) throw new Error(data.detail || "Scanning Gagal");
       setDiscoveryResults(data.devices || []);
    })
    .catch(err => alert(err.message))
    .finally(() => setIsDiscovering(false));
  };

  const handleBulkAddDiscovered = async () => {
     if(selectedDiscovered.length === 0) return;
     const toAdd = discoveryResults.filter(d => selectedDiscovered.includes(d.ip));
     let successCount = 0;
     for(const item of toAdd) {
        let devId = (item.snmp?.sys_descr?.substring(0,10) || item.vendor || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + item.ip.replace(/\./g, '-');
        const finalDev = {
           id: devId,
           hostname: devId,
           ip_address: item.ip,
           type: 'Router',
           vendor: item.snmp?.vendor || 'Generic',
           snmp_community: item.snmp?.community || 'public',
           snmp_port: 161,
           ssh_user: discoveryParam.ssh_user,
           ssh_pass: discoveryParam.ssh_pass,
           ssh_port: 22,
           ssh_protocol: 'ssh',
           thresholds: { cpu: 80, ping: 150 }
        };
        try {
           const res = await fetch('/api/devices/', {
             method: 'POST',
             headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keycloak.token}` },
             body: JSON.stringify(finalDev)
           });
           if(res.ok) successCount++;
        } catch(err) { console.error("Error bulk insert:", err); }
     }
     alert(`Berhasil menambahkan ${successCount} node baru ke NMS!`);
     setShowDiscoveryModal(false);
     fetchDevices();
  };


  if (!keycloakAuth.authenticated) {
    return (
      <div className="login-container">
        <div className="glass-panel login-box" style={{textAlign: 'center'}}>
          <div style={{ fontSize: '56px', marginBottom: '24px', animation: 'spin 2s linear infinite' }}>⏳</div>
          <h2>Authenticating via Keycloak...</h2>
          <p style={{color: 'var(--text-muted)'}}>Connecting to Central Identity Provider</p>
        </div>
      </div>
    );
  }

  const userName = keycloak?.tokenParsed?.preferred_username || 'Administrator';
  const fullName = keycloak?.tokenParsed?.given_name ? `${keycloak.tokenParsed.given_name} ${keycloak.tokenParsed.family_name}` : userName;
  const isAdmin = keycloak?.tokenParsed?.realm_access?.roles?.includes('admin') ?? false;

  return (
    <div className="app-container" style={{ position: 'relative' }}>
      
      {showModal && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.7)', backdropFilter: 'blur(5px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }}>
          <div className="glass-panel" style={{ width: '500px', padding: '32px', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0, color: 'white' }}>{isEditMode ? '⚙️ Edit Device Config' : 'Register Real Device'}</h3>
              <span style={{ cursor: 'pointer', fontSize: '24px' }} onClick={() => setShowModal(false)}>❌</span>
            </div>
            <form onSubmit={handleSaveDevice}>
              <div className="input-group" style={{ display: 'flex', gap: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label>Hostname</label>
                  <input type="text" value={newDev.hostname} onChange={e => setNewDev({...newDev, hostname: e.target.value})} required />
                </div>
                <div style={{ flex: 1 }}>
                  <label>IP Address</label>
                  <input type="text" value={newDev.ip_address} onChange={e => setNewDev({...newDev, ip_address: e.target.value})} required pattern="^(\d{1,3}\.){3}\d{1,3}$" title="IPv4 valid" />
                </div>
              </div>
              <div className="input-group" style={{ display: 'flex', gap: '16px' }}>
                <div style={{ flex: 1 }}>
                  <label>Type</label>
                  <select 
                    style={{ width: '100%', padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', borderRadius: '8px', color: '#fff', outline: 'none' }}
                    value={newDev.type} onChange={e => setNewDev({...newDev, type: e.target.value})}>
                    <option value="Router" style={{color: 'black'}}>Router</option>
                    <option value="Switch" style={{color: 'black'}}>Switch</option>
                    <option value="Firewall" style={{color: 'black'}}>Firewall</option>
                    <option value="Server" style={{color: 'black'}}>Server</option>
                  </select>
                </div>
                <div style={{ flex: 1 }}>
                  <label>Vendor</label>
                  <select 
                    style={{ width: '100%', padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', borderRadius: '8px', color: '#fff', outline: 'none' }}
                    value={newDev.vendor} onChange={e => setNewDev({...newDev, vendor: e.target.value})}>
                    <option value="Cisco" style={{color: 'black'}}>Cisco IOS</option>
                    <option value="Juniper" style={{color: 'black'}}>Juniper JunOS</option>
                    <option value="MikroTik" style={{color: 'black'}}>MikroTik RouterOS</option>
                    <option value="Fortinet" style={{color: 'black'}}>Fortinet FortiOS</option>
                    <option value="Huawei" style={{color: 'black'}}>Huawei Netengine / VRP</option>
                    <option value="ZTE" style={{color: 'black'}}>ZTE OLT (ZXROS)</option>
                    <option value="H3C" style={{color: 'black'}}>H3C (Comware)</option>
                    <option value="Ruijie" style={{color: 'black'}}>Ruijie OS</option>
                    <option value="VyOS" style={{color: 'black'}}>VyOS / Vyatta</option>
                    <option value="DANOS" style={{color: 'black'}}>DANOS</option>
                    <option value="Palo Alto" style={{color: 'black'}}>Palo Alto PAN-OS</option>
                    <option value="Linux/Ubuntu" style={{color: 'black'}}>Linux / Ubuntu / Debian</option>
                    <option value="Aruba" style={{color: 'black'}}>Aruba OS</option>
                    <option value="Generic" style={{color: 'black'}}>Generic Terminal Server</option>
                  </select>
                </div>
              </div>
              
              <div style={{borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '8px'}}>
                <h4 style={{fontSize: '14px', color:'var(--primary-hover)', marginBottom: '16px'}}>Authentication & Kredensial</h4>
                <div className="input-group" style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ flex: 3 }}>
                    <label>SNMP Community</label>
                    <input type="text" value={newDev.snmp_community} onChange={e => setNewDev({...newDev, snmp_community: e.target.value})} placeholder="public" required />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>SNMP Port</label>
                    <input type="number" value={newDev.snmp_port} onChange={e => setNewDev({...newDev, snmp_port: parseInt(e.target.value)})} placeholder="161" required />
                  </div>
                </div>
                <div className="input-group" style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ flex: 1 }}>
                    <label>Protocol</label>
                    <select 
                      style={{ width: '100%', padding: '12px', background: 'rgba(0,0,0,0.2)', border: '1px solid var(--border)', borderRadius: '8px', color: '#fff', outline: 'none' }}
                      value={newDev.ssh_protocol} onChange={e => setNewDev({...newDev, ssh_protocol: e.target.value})}>
                      <option value="ssh" style={{color: 'black'}}>SSH</option>
                      <option value="telnet" style={{color: 'black'}}>Telnet</option>
                    </select>
                  </div>
                  <div style={{ flex: 2 }}>
                    <label>Username</label>
                    <input type="text" value={newDev.ssh_user} onChange={e => setNewDev({...newDev, ssh_user: e.target.value})} placeholder="admin" />
                  </div>
                  <div style={{ flex: 2 }}>
                    <label>Password</label>
                    <input type="password" value={newDev.ssh_pass} onChange={e => setNewDev({...newDev, ssh_pass: e.target.value})} placeholder="••••••" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Port</label>
                    <input type="number" value={newDev.ssh_port} onChange={e => setNewDev({...newDev, ssh_port: parseInt(e.target.value)})} placeholder="22" />
                  </div>
                </div>
              </div>

              <div style={{borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '8px'}}>
                <h4 style={{fontSize: '14px', color:'var(--primary)', marginBottom: '16px'}}>Custom Alerts Threshold</h4>
                <div className="input-group" style={{ display: 'flex', gap: '8px' }}>
                  <div style={{ flex: 1 }}>
                    <label>CPU Block Level (%)</label>
                    <input type="number" max="100" min="1" value={newDev.thresholds?.cpu || 80} onChange={e => setNewDev({...newDev, thresholds: {...newDev.thresholds, cpu: parseInt(e.target.value)}})} placeholder="80" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>Ping Latency Limit (ms)</label>
                    <input type="number" value={newDev.thresholds?.ping || 150} onChange={e => setNewDev({...newDev, thresholds: {...newDev.thresholds, ping: parseInt(e.target.value)}})} placeholder="150" />
                  </div>
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '16px' }}>
                <button type="button" onClick={handleTestConnection} disabled={isTesting} style={{ border: '1px solid var(--success)', color: 'var(--success)', padding: '10px 16px', background: 'transparent', cursor: 'pointer', borderRadius: '4px', fontWeight: 'bold' }}>
                  {isTesting ? '⏳ Testing Connection...' : '⚡ Test SSH & SNMP'}
                </button>
                <button type="submit" className="btn-primary" style={{ padding: '10px 24px', margin: 0 }}>
                  {isEditMode ? 'Update Configuration' : 'Save to DB PostgreSQL'}
                </button>
              </div>

              {testResult && (
                <div style={{ marginTop: '16px', padding: '12px', background: 'rgba(0,0,0,0.4)', borderRadius: '4px', border: '1px solid rgba(255,255,255,0.1)', fontSize: '13px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '12px', color: testResult.snmp.success ? 'var(--success)' : 'orange' }}>
                    <span style={{ fontSize: '16px' }}>{testResult.snmp.success ? '✅' : '❌'}</span>
                    <span><strong>SNMP:</strong> {testResult.snmp.message}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: testResult.remote.success ? 'var(--success)' : 'var(--danger)' }}>
                    <span style={{ fontSize: '16px' }}>{testResult.remote.success ? '✅' : '❌'}</span>
                    <span><strong>Remote (SSH/Telnet):</strong> {testResult.remote.message}</span>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>
      )}

      {/* MODAL SUBNET DISCOVERY */}
      {showDiscoveryModal && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.8)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1050
        }}>
          <div className="glass-panel" style={{ width: '800px', padding: '32px', maxHeight: '90vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span>📡</span> Network Subnet Auto-Discovery
              </h3>
              <span style={{ cursor: 'pointer', fontSize: '24px' }} onClick={() => setShowDiscoveryModal(false)}>❌</span>
            </div>
            
            <form onSubmit={handleDiscoverySubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginBottom: '24px' }}>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label>Target Subnet (CIDR)</label>
                  <input type="text" value={discoveryParam.subnet} onChange={e => setDiscoveryParam({...discoveryParam, subnet: e.target.value})} placeholder="192.168.1.0/24" required pattern="^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$" />
                </div>
                <div style={{ flex: 2 }}>
                  <label>SNMP Communities</label>
                  <input type="text" value={discoveryParam.snmp_communities} onChange={e => setDiscoveryParam({...discoveryParam, snmp_communities: e.target.value})} placeholder="public, private, nms" required />
                </div>
              </div>
              <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <label>SSH/Telnet Default User (Opsi Bukaan Port)</label>
                  <input type="text" value={discoveryParam.ssh_user} onChange={e => setDiscoveryParam({...discoveryParam, ssh_user: e.target.value})} placeholder="admin" />
                </div>
                <div style={{ flex: 1 }}>
                  <label>SSH/Telnet Default Pass (Opsi Bukaan Port)</label>
                  <input type="password" value={discoveryParam.ssh_pass} onChange={e => setDiscoveryParam({...discoveryParam, ssh_pass: e.target.value})} placeholder="********" />
                </div>
                <div style={{ width: '150px' }}>
                  <button type="submit" className="btn-primary" disabled={isDiscovering} style={{ width: '100%', margin: 0 }}>
                    {isDiscovering ? '⏳ Scanning...' : '🚀 Start Sweep'}
                  </button>
                </div>
              </div>
            </form>

            {isDiscovering && (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--primary-hover)' }}>
                <div style={{ fontSize: '48px', animation: 'spin 2s linear infinite', marginBottom: '16px' }}>⚙️</div>
                <h3>Sweeping Network...</h3>
                <p style={{ color: 'var(--text-muted)' }}>Menembakkan ICMP Ping, SNMP Probes, dan SSH/Telnet Capabilities lintas Subnet.</p>
              </div>
            )}

            {discoveryResults && !isDiscovering && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingBottom: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', marginBottom: '16px' }}>
                  <h4 style={{ margin: 0, color: 'var(--success)' }}>Berhasil Menemukan {discoveryResults.length} Node Aktif!</h4>
                  <button onClick={handleBulkAddDiscovered} className="btn-primary" style={{ margin: 0, padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', background: 'var(--success)', borderColor: 'var(--success)' }} disabled={selectedDiscovered.length === 0}>
                    <span>➕</span> Bulk Import ke NMS ({selectedDiscovered.length})
                  </button>
                </div>
                
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--border)', color: '#9ca3af' }}>
                      <th style={{ padding: '8px', width: '40px', textAlign: 'center' }}>
                         <input type="checkbox" 
                           onChange={(e) => {
                              if(e.target.checked) setSelectedDiscovered(discoveryResults.map(r => r.ip));
                              else setSelectedDiscovered([]);
                           }} 
                           checked={discoveryResults.length > 0 && selectedDiscovered.length === discoveryResults.length}
                         />
                      </th>
                      <th style={{ padding: '8px' }}>IP Address</th>
                      <th style={{ padding: '8px' }}>SNMP Detection (sysDescr)</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>SSH (22)</th>
                      <th style={{ padding: '8px', textAlign: 'center' }}>Telnet (23)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {discoveryResults.length === 0 ? (
                      <tr><td colSpan="5" style={{ textAlign: 'center', padding: '24px', color: '#666' }}>Tidak ada pergerakan di subnet ini. Kosong.</td></tr>
                    ) : (
                      discoveryResults.map(res => (
                        <tr key={res.ip} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: selectedDiscovered.includes(res.ip) ? 'rgba(52, 211, 153, 0.15)' : 'transparent' }}>
                          <td style={{ padding: '8px', textAlign: 'center' }}>
                            <input type="checkbox" 
                               checked={selectedDiscovered.includes(res.ip)}
                               onChange={() => {
                                  setSelectedDiscovered(prev => prev.includes(res.ip) ? prev.filter(x => x !== res.ip) : [...prev, res.ip]);
                               }} 
                            />
                          </td>
                          <td style={{ padding: '8px', fontWeight: 'bold', fontFamily: 'monospace', color: 'var(--primary-hover)' }}>{res.ip}</td>
                          <td style={{ padding: '8px' }}>
                             {res.snmp?.success ? (
                                <div>
                                   <div style={{ color: 'var(--success)', fontWeight: 'bold' }}>✅ {res.snmp.vendor} <span style={{fontSize: '11px', color: '#9ca3af'}}>({res.snmp.community})</span></div>
                                   <div style={{ fontSize: '11px', color: '#6b7280', marginTop: '4px' }}>{res.snmp.sys_descr}</div>
                                </div>
                             ) : <span style={{ color: '#ef4444' }}>❌ No Response</span>}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'center', fontSize: '16px' }}>{res.ssh_port_22 ? '✅' : '❌'}</td>
                          <td style={{ padding: '8px', textAlign: 'center', fontSize: '16px' }}>{res.telnet_port_23 ? '✅' : '❌'}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </div>
      )}


      {/* MODAL METRIC/GRAFANA */}
      {metricsDevice && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100
        }}>
          <div className="glass-panel" style={{ width: '85%', height: '85%', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '20px' }}>
                <h3 style={{ margin: 0, color: '#fff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>📊</span> Live Telemetry: <span style={{color: 'var(--primary-hover)'}}>{metricsDevice.name || metricsDevice.hostname} ({metricsDevice.ip})</span>
                </h3>
                
                {/* Time Range Selector */}
                <select 
                  className="device-select"
                  style={{ background: 'rgba(0,0,0,0.3)', border: '1px solid rgba(255,255,255,0.2)', color: 'white', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', outline: 'none' }}
                  value={timeRange}
                  onChange={(e) => setTimeRange(e.target.value)}
                >
                  <option value="5m">Last 5 minutes</option>
                  <option value="15m">Last 15 minutes</option>
                  <option value="1h">Last 1 hour</option>
                  <option value="6h">Last 6 hours</option>
                  <option value="24h">Last 24 hours</option>
                  <option value="7d">Last 7 days</option>
                  <option value="30d">Last 30 days</option>
                  <option value="1y">Last 1 year</option>
                </select>

                <div style={{ display: 'flex', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', padding: '2px' }}>
                   <button className="btn-outline" style={{ padding: '6px 12px', border: 'none', background: telemetryTab === 'ping' ? 'var(--primary-color)' : 'transparent', color: '#fff', margin: 0 }} onClick={() => setTelemetryTab('ping')}>General Ping</button>
                   <button className="btn-outline" style={{ padding: '6px 12px', border: 'none', background: telemetryTab === 'advanced' ? 'var(--primary-color)' : 'transparent', color: '#fff', margin: 0 }} onClick={() => setTelemetryTab('advanced')}>Advanced (SNMP)</button>
                </div>
              </div>
              <span style={{ cursor: 'pointer', fontSize: '24px' }} onClick={() => setMetricsDevice(null)}>❌</span>
            </div>
            
            <div style={{ flex: 1, border: '1px solid rgba(255,255,255,0.1)', borderRadius: '8px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              {telemetryTab === 'ping' ? (
                <iframe 
                  src={`${window.location.origin}/grafana/d-solo/nexus-nms-core/nexus-nms-network-health?orgId=1&theme=dark&panelId=1&refresh=5s&from=now-${timeRange}&to=now&var-target=${metricsDevice.id}`} 
                  width="100%" height="100%" frameBorder="0" style={{ display: 'block', background: '#000' }} title="Ping Latency">
                </iframe>
              ) : (
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                  {/* TOP PANEL: ANALYTICS HUB & CPU GAUGE (55% height) */}
                  <div style={{ height: '55%', display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.1)' }}>
                    {selectedInterface ? (
                       <>
                         <div style={{ width: '75%', borderRight: '1px solid rgba(255,255,255,0.1)', background: '#000' }}>
                           <iframe 
                             src={`${window.location.origin}/grafana/d-solo/nexus-nms-advanced/nexus-nms-advanced-telemetry?orgId=1&theme=dark&panelId=2&refresh=10s&from=now-${timeRange}&to=now&var-target=${metricsDevice.id}&var-interface=${encodeURIComponent(selectedInterface)}`} 
                             width="100%" height="100%" frameBorder="0" style={{ display: 'block' }} title="Interface Traffic">
                           </iframe>
                         </div>
                         <div style={{ width: '25%', background: '#000' }}>
                           <iframe 
                             src={`${window.location.origin}/grafana/d-solo/nexus-nms-advanced/nexus-nms-advanced-telemetry?orgId=1&theme=dark&panelId=1&refresh=10s&from=now-${timeRange}&to=now&var-target=${metricsDevice.id}`} 
                             width="100%" height="100%" frameBorder="0" style={{ display: 'block' }} title="CPU Gauge">
                           </iframe>
                         </div>
                       </>
                    ) : (
                       <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#666', flexDirection: 'column', gap: '16px', background: '#000' }}>
                          <span style={{fontSize:'48px', color: '#374151'}}>📈</span>
                          <span style={{fontSize:'16px', color: '#9ca3af'}}>Select an active sensor from the table below to view analytical instruments.</span>
                       </div>
                    )}
                  </div>

                  {/* BOTTOM PANEL: PRTG SENSOR LIST TABLE (45% height) */}
                  <div style={{ height: '45%', overflowY: 'auto', background: '#111827' }}>
                       <table style={{ width: '100%', borderCollapse: 'collapse', color: '#fff', fontSize: '13px' }}>
                          <thead style={{ position: 'sticky', top: 0, background: '#1f2937', color: '#9ca3af', textAlign: 'left', zIndex: 10, boxShadow: '0 2px 4px rgba(0,0,0,0.5)' }}>
                             <tr>
                                <th style={{ padding: '10px 12px', borderBottom: '1px solid #374151' }}>Pos</th>
                                <th style={{ padding: '10px 12px', borderBottom: '1px solid #374151' }}>Sensor (Port)</th>
                                <th style={{ padding: '10px 12px', borderBottom: '1px solid #374151' }}>Status</th>
                                <th style={{ padding: '10px 12px', borderBottom: '1px solid #374151' }}>Monitoring</th>
                                <th style={{ padding: '10px 12px', borderBottom: '1px solid #374151' }}>Action</th>
                             </tr>
                          </thead>
                          <tbody>
                             {interfacesLoading ? (
                                <tr><td colSpan="5" style={{padding:'20px', textAlign:'center', color:'#888'}}>Scanning active sensors...</td></tr>
                             ) : deviceInterfaces.length === 0 ? (
                                <tr><td colSpan="5" style={{padding:'20px', textAlign:'center', color:'var(--danger)'}}>No active traffic detected.</td></tr>
                             ) : (
                                deviceInterfaces.map((iface, idx) => (
                                   <tr key={iface.name} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', background: selectedInterface === iface.name ? 'rgba(52, 211, 153, 0.15)' : (idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.02)'), transition: 'all 0.2s' }}>
                                      <td style={{ padding: '10px 12px', color: '#6b7280' }}>{idx + 1}</td>
                                      <td style={{ padding: '10px 12px', fontWeight: 600 }}>
                                         {iface.name} 
                                         {iface.alias ? <div style={{color: '#9ca3af', fontWeight: 400, fontSize: '11px', marginTop: '2px'}}>{iface.alias}</div> : null}
                                      </td>
                                      <td style={{ padding: '10px 12px' }}>
                                         {iface.is_monitored 
                                            ? <span style={{ color: '#10b981', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}><div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#10b981'}}></div> UP</span> 
                                            : <span style={{ color: '#ef4444', display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px' }}><div style={{width:'8px',height:'8px',borderRadius:'50%',background:'#ef4444'}}></div> PAUSED</span>}
                                      </td>
                                      <td style={{ padding: '10px 12px' }}>
                                         <label className="switch" style={{ margin: 0, scale: '0.8' }}>
                                           <input type="checkbox" checked={iface.is_monitored} onChange={() => handleToggleMonitoring(iface.name, iface.is_monitored)} />
                                           <span className="slider round"></span>
                                         </label>
                                      </td>
                                      <td style={{ padding: '10px 12px' }}>
                                        <button 
                                          onClick={() => setSelectedInterface(iface.name)} 
                                          style={{ padding: '6px 12px', background: selectedInterface === iface.name ? 'var(--primary-color)' : 'rgba(255,255,255,0.1)', color: '#fff', border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '11px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
                                          {selectedInterface === iface.name ? '▶ Viewing' : '📊 View'}
                                        </button>
                                      </td>
                                   </tr>
                                ))
                             )}
                          </tbody>
                       </table>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Sidebar Navigation */}
      <aside className="glass-panel sidebar" style={{ borderRadius: 0, borderTop: 0, borderBottom: 0, borderLeft: 0 }}>
        <div className="brand">
          <span style={{ fontSize: '28px', marginRight: '8px' }}>⚡</span>
          Nexus NMS
        </div>
        
        <nav className="nav-menu">
          <div className={`nav-item ${activeTab === 'dashboard' ? 'active' : ''}`} onClick={() => setActiveTab('dashboard')}>
            <span style={{marginRight:'8px'}}>📊</span> Dashboard Overview
          </div>
          <div className={`nav-item ${activeTab === 'ncm' ? 'active' : ''}`} onClick={() => setActiveTab('ncm')}>
            <span style={{marginRight:'8px'}}>📜</span> Config Manager (NCM)
          </div>
          <div className={`nav-item ${activeTab === 'topology' ? 'active' : ''}`} onClick={() => setActiveTab('topology')}>
            <span style={{marginRight:'8px'}}>🗺️</span> Network Topology Map
          </div>
          <div className={`nav-item ${activeTab === 'inventory' ? 'active' : ''}`} onClick={() => setActiveTab('inventory')}>
            <span style={{marginRight:'8px'}}>🖥️</span> Devices Inventory
          </div>
          <div className={`nav-item ${activeTab === 'syslogs' ? 'active' : ''}`} onClick={() => setActiveTab('syslogs')}>
            <span style={{marginRight:'8px'}}>⚠️</span> Logs & Traps
          </div>
          <div className={`nav-item ${activeTab === 'alarms' ? 'active' : ''}`} onClick={() => setActiveTab('alarms')}>
            <span style={{marginRight:'8px'}}>🚨</span> Alert Manager
          </div>
          <div className={`nav-item ${activeTab === 'reports' ? 'active' : ''}`} onClick={() => setActiveTab('reports')}>
            <span style={{marginRight:'8px'}}>📄</span> Executive Reports
          </div>
          <div className={`nav-item ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
            <span style={{marginRight:'8px'}}>⚙️</span> System Settings
          </div>
        </nav>

        <div style={{ marginTop: 'auto' }}>
          <div className="nav-item" onClick={doLogout} style={{cursor: 'pointer'}}>
            <span style={{marginRight:'8px'}}>🚪</span> SSO Sign Out
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      <main className="main-content">
        <header className="header" style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
          <h2>Network Operations Center</h2>
          <div className="user-profile" style={{display: 'flex', alignItems: 'center', gap: '12px'}}>
            <div style={{textAlign: 'right'}}>
              <div style={{fontWeight: 600, color: '#fff'}}>{fullName}</div>
              <div style={{ fontSize: '12px', color: 'var(--success)' }}>
                ● JWT SSO Verified
              </div>
            </div>
            <div className="avatar">{userName.charAt(0).toUpperCase()}</div>
          </div>
        </header>

        {/* == TAB DASHBOARD == */}
        {activeTab === 'dashboard' && (
          <>
            {/* Highlight Stats */}
            <div className="stats-grid">
              <div className="glass-panel stat-card">
                <span className="stat-title">Database Records</span>
                <span className="stat-value">{devices.length}</span>
              </div>
              <div className="glass-panel stat-card">
                <span className="stat-title">Monitored Nodes</span>
                <span className="stat-value" style={{ color: 'var(--success)' }}>{devices.filter(d => d.status === 'UP').length}</span>
              </div>
              <div className="glass-panel stat-card">
                <span className="stat-title">Offline Nodes</span>
                <span className="stat-value" style={{ color: 'var(--danger)' }}>{devices.filter(d => d.status !== 'UP').length}</span>
              </div>
            </div>

            {/* Top 5 Metrics Hub */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px', marginBottom: '40px' }}>
               {/* TOP CPU */}
               <div className="glass-panel" style={{ padding: '20px', borderTop: '4px solid #ef4444' }}>
                  <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><span>🔥</span> Top 5 CPU Utilization</h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', marginTop: '16px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', color: '#9ca3af', textAlign: 'left' }}>
                        <th style={{ paddingBottom: '8px' }}>Router</th>
                        <th style={{ paddingBottom: '8px', textAlign: 'right' }}>% Load</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topMetrics.top_cpu.length === 0 ? <tr><td colSpan="2" style={{paddingTop:'16px', color:'#666', textAlign: 'center'}}>No active CPU data.</td></tr> : topMetrics.top_cpu.map((m, idx) => {
                         const dev = devices.find(d => d.id === m.device_id);
                         const name = dev ? dev.name : m.device_id;
                         return (
                           <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                             <td style={{ padding: '12px 0', fontWeight: 'bold' }}>{name} <span style={{fontSize:'11px', color:'#9ca3af'}}>({m.device_id})</span></td>
                             <td style={{ padding: '12px 0', textAlign: 'right', color: m.value > 80 ? '#ef4444' : (m.value > 50 ? '#f59e0b' : '#10b981'), fontWeight: 'bold' }}>{m.value.toFixed(1)}%</td>
                           </tr>
                         );
                      })}
                    </tbody>
                  </table>
               </div>

               {/* TOP LATENCY */}
               <div className="glass-panel" style={{ padding: '20px', borderTop: '4px solid #f59e0b' }}>
                  <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}><span>⚠️</span> Top 5 Worst Latency</h3>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px', marginTop: '16px' }}>
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border)', color: '#9ca3af', textAlign: 'left' }}>
                        <th style={{ paddingBottom: '8px' }}>Router</th>
                        <th style={{ paddingBottom: '8px', textAlign: 'right' }}>Ping (ms)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {topMetrics.top_latency.length === 0 ? <tr><td colSpan="2" style={{paddingTop:'16px', color:'#666', textAlign: 'center'}}>No active Ping data.</td></tr> : topMetrics.top_latency.map((m, idx) => {
                         const dev = devices.find(d => d.id === m.device_id);
                         const name = dev ? dev.name : m.device_id;
                         return (
                           <tr key={idx} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                             <td style={{ padding: '12px 0', fontWeight: 'bold' }}>{name} <span style={{fontSize:'11px', color:'#9ca3af'}}>({m.device_id})</span></td>
                             <td style={{ padding: '12px 0', textAlign: 'right', color: m.value > 100 ? '#ef4444' : (m.value > 50 ? '#f59e0b' : '#10b981'), fontWeight: 'bold' }}>{m.value.toFixed(1)} ms</td>
                           </tr>
                         );
                      })}
                    </tbody>
                  </table>
               </div>
            </div>

            {/* Grafana Live Telemetry Embed */}
            <div className="glass-panel" style={{ marginBottom: '40px', overflow: 'hidden', padding: 0 }}>
              <iframe 
                src={`${window.location.origin}/grafana/d-solo/nexus-nms-core/nexus-nms-network-health?orgId=1&theme=dark&panelId=1&refresh=10s&from=now-6h&to=now%2B6h`} 
                width="100%" 
                height="350" 
                frameBorder="0" 
                style={{ display: 'block' }}
                title="Realtime Latency Graph">
              </iframe>
            </div>
          </>
        )}

        {/* == TAB DEVICES INVENTORY == */}
        {activeTab === 'inventory' && (
          <>
            {/* Device Tracking Table */}
            <div className="glass-panel device-list">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span>🖥️</span> Database Inventory
                </h3>
                <div style={{ display: 'flex', gap: '8px' }}>
                  {isAdmin && (
                    <>
                      <input type="file" id="import-json" style={{display: 'none'}} accept=".csv" onChange={handleImportDevices} />
                      <button className="btn-outline" onClick={() => document.getElementById('import-json').click()} title="Import CSV" style={{ width: 'auto', padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', color: 'white', cursor: 'pointer', borderRadius: '4px' }}>
                        📥 Import CSV
                      </button>
                      <button className="btn-outline" onClick={handleExportDevices} title="Export CSV" style={{ width: 'auto', padding: '8px 16px', background: 'transparent', border: '1px solid var(--border)', color: 'white', cursor: 'pointer', borderRadius: '4px' }}>
                        📤 Export CSV
                      </button>
                      <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', background: 'var(--success)', borderColor: 'var(--success)' }} onClick={() => setShowDiscoveryModal(true)}>
                        <span>📡</span> Subnet Auto-Discovery
                      </button>
                      <button className="btn-primary" style={{ width: 'auto', padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }} onClick={openAddModal}>
                        <span>➕</span> Add Device
                      </button>
                    </>
                  )}
                </div>
              </div>

              <table>
                <thead>
                  <tr>
                    <th>Device ID</th>
                    <th>Hostname</th>
                    <th>IP / Port</th>
                    <th>Vendor</th>
                    <th>Database Status</th>
                    <th style={{textAlign:'center'}}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.length === 0 ? (
                    <tr>
                      <td colSpan="6" style={{ textAlign: 'center', padding: '32px', color: 'var(--text-muted)' }}>
                        DATABASE KOSONG: Tambahkan perangkat untuk disinkronisasikan ke DB PostgreSQL.
                      </td>
                    </tr>
                  ) : devices.map(dev => (
                    <tr key={dev.id} style={{ transition: 'background 0.2s', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                      <td style={{ fontWeight: 500 }}>{dev.id}</td>
                      <td>{dev.name}</td>
                      <td style={{ fontFamily: 'monospace', color: 'var(--primary-hover)' }}>{dev.ip} : {dev.ssh_port}</td>
                      <td>{dev.vendor}</td>
                      <td><span className="status-badge status-up">SYNCED</span></td>
                      <td style={{textAlign:'center'}}>
                        <button style={{ background: 'transparent', border: 'none', color: '#00f5d4', cursor: 'pointer', padding: '4px', marginRight:'8px', fontWeight: 'bold' }} onClick={() => setMetricsDevice(dev)} title="View Telemetry">
                          📊 Stats
                        </button>
                        {isAdmin && (
                          <>
                            <button style={{ background: 'transparent', border: 'none', color: 'var(--primary-hover)', cursor: 'pointer', padding: '4px', marginRight:'8px', fontWeight: 'bold' }} onClick={() => openEditModal(dev)} title="Edit Device">
                              ✏️ Edit
                            </button>
                            <button style={{ background: 'transparent', border: 'none', color: 'var(--danger)', cursor: 'pointer', padding: '4px', fontWeight: 'bold' }} onClick={() => deleteDevice(dev.id)} title="Delete Device">
                              🗑️ Del
                            </button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {/* == TAB NCM (NETWORK CONFIG MANAGER) == */}
        {activeTab === 'ncm' && (
          <div className="ncm-module">
            
            {!selectedDeviceForNcm ? (
              // Halaman 1: Nodes List (Mencirikan Oxidized Home)
              <div className="glass-panel" style={{ width: '100%' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                  <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span style={{ color: 'var(--primary)' }}>📜</span> Oxidized-Style Node Inventory
                  </h2>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
                  <thead>
                    <tr style={{ background: 'rgba(255,255,255,0.05)', textAlign: 'left' }}>
                      <th style={{ padding: '12px' }}>Node Name</th>
                      <th style={{ padding: '12px' }}>IP Address</th>
                      <th style={{ padding: '12px' }}>Model / Vendor</th>
                      <th style={{ padding: '12px' }}>Status Tracker</th>
                      <th style={{ padding: '12px', textAlign: 'center' }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {devices.length === 0 ? (
                      <tr><td colSpan="5" style={{ padding: '24px', textAlign: 'center', color: 'var(--text-muted)' }}>Belum ada Nodes di Sistem.</td></tr>
                    ) : (
                      devices.map(dev => (
                        <tr key={dev.id} style={{ borderBottom: '1px solid var(--border)', transition: 'background 0.2s', cursor: 'default' }}>
                          <td style={{ padding: '12px', fontWeight: 'bold' }}>{dev.name}</td>
                          <td style={{ padding: '12px', fontFamily: 'monospace', color: 'var(--text-muted)' }}>{dev.ip}</td>
                          <td style={{ padding: '12px' }}>{dev.vendor}</td>
                          <td style={{ padding: '12px' }}><span className="status-badge status-up">Monitored</span></td>
                          <td style={{ padding: '12px', textAlign: 'center' }}>
                            <button 
                              className="btn-primary" 
                              onClick={() => fetchConfigHistory(dev.id)}
                              style={{ padding: '6px 16px', fontSize: '13px', width: 'auto', background: 'transparent', border: '1px solid var(--primary)', color: 'var(--primary)', transition: '0.2s' }}>
                              View Versions
                            </button>
                            {isAdmin && (
                              <button 
                                onClick={() => handleTriggerBackup(dev.id)}
                                style={{ padding: '6px 16px', fontSize: '13px', marginLeft: '8px', background: 'transparent', border: '1px solid var(--success)', color: 'var(--success)', cursor: 'pointer', borderRadius: '4px' }}>
                                Backup Now
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              // Halaman 2: Versi dan Diff (Mencirikan Oxidized Node Page)
              <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <button 
                    onClick={() => setSelectedDeviceForNcm(null)}
                    style={{ background: 'var(--border)', border: 'none', color: '#fff', padding: '8px 16px', borderRadius: '4px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 'bold' }}>
                    ← Back to Nodes
                  </button>
                  <h2 style={{ margin: 0 }}>Histori Konfigurasi Tracker</h2>
                </div>

                <div className="glass-panel" style={{ width: '100%' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
                    <h3 style={{ margin: 0 }}>Daftar Versi</h3>
                    <button onClick={handleCompare} className="btn-primary" style={{ background: '#4b5563', width: 'auto' }} disabled={compareIds.length !== 2}>
                      ⚖️ Bandingkan Diff (Checklist 2)
                    </button>
                  </div>
                  
                  {configHistory.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)' }}>Belum ada histori backup untuk perangkat ini.</p>
                  ) : (
                    <div style={{ maxHeight: '300px', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: '8px' }}>
                      <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse', fontSize: '14px' }}>
                        <thead style={{ position: 'sticky', top: 0, background: '#1f2937', zIndex: 1 }}>
                          <tr>
                            <th style={{ padding: '12px', width: '50px', textAlign: 'center' }}>Diff</th>
                            <th style={{ padding: '12px' }}>Timestamp (Date/Time)</th>
                            <th style={{ padding: '12px' }}>Commit / Hash SHA256</th>
                            <th style={{ padding: '12px' }}>Tindakan</th>
                          </tr>
                        </thead>
                        <tbody>
                          {configHistory.map(hist => (
                            <tr key={hist.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)', backgroundColor: compareIds.includes(hist.id) ? 'rgba(59, 130, 246, 0.1)' : 'transparent' }}>
                              <td style={{ padding: '12px', textAlign: 'center' }}>
                                <input type="checkbox" checked={compareIds.includes(hist.id)} onChange={() => toggleCompareId(hist.id)} />
                              </td>
                              <td style={{ padding: '12px' }}>{new Date(hist.created_at).toLocaleString()}</td>
                              <td style={{ padding: '12px', fontFamily: 'monospace', color: 'var(--success)' }}>{hist.version_hash.substring(0, 16)}...</td>
                              <td style={{ padding: '12px', display: 'flex', gap: '8px' }}>
                                <button onClick={() => setViewConfigData(hist)} style={{ background: 'var(--primary)', border: 'none', color: '#fff', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>
                                  👁️ VIEW
                                </button>
                                {isAdmin && (
                                  <button onClick={() => handleRestore(selectedDeviceForNcm, hist.id)} style={{ background: 'var(--danger)', border: 'none', color: '#fff', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '12px' }}>
                                    ⟲ RESTORE
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* View Raw Config */}
                {viewConfigData && (
                  <div className="glass-panel" style={{ position: 'relative' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '1px solid var(--border)', paddingBottom: '12px', marginBottom: '16px' }}>
                      <div>
                        <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{color: 'var(--primary)'}}>📄</span> Raw Configuration #{viewConfigData.id}
                        </h3>
                        <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>
                          <span style={{fontFamily: 'monospace', color: 'var(--success)'}}>{viewConfigData.version_hash}</span> • {new Date(viewConfigData.created_at).toLocaleString()}
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        <button 
                          onClick={() => handleCopy(viewConfigData.config_text, 'raw')}
                          style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid var(--border)', color: '#fff', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', transition: '0.2s' }}>
                          {copyStatus === 'raw' ? '✅ Copied!' : '📋 Copy Text'}
                        </button>
                        <button 
                          onClick={() => setViewConfigData(null)} 
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer', padding: '4px' }}>
                          ✕
                        </button>
                      </div>
                    </div>
                    <div style={{ background: '#0f1115', borderRadius: '8px', border: '1px solid #1f2937', overflow: 'hidden' }}>
                      <div style={{ background: '#1f2937', padding: '6px 12px', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold' }}>
                        Configuration Body
                      </div>
                      <pre style={{ margin: 0, padding: '16px', color: '#a5b4fc', overflowX: 'auto', maxHeight: '500px', fontSize: '13px', lineHeight: '1.5' }}>
                        {viewConfigData.config_text}
                      </pre>
                    </div>
                  </div>
                )}

                {/* Diff Viewer */}
                {diffResult && (
                  <div className="glass-panel" style={{ position: 'relative', borderTop: '4px solid var(--primary)' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '12px', marginBottom: '16px' }}>
                      <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{color: '#f59e0b'}}>⚖️</span> Unified Configuration Diff
                      </h3>
                      <div style={{ display: 'flex', gap: '8px' }}>
                        {!diffResult.is_identical && (
                          <button 
                            onClick={() => handleCopy(diffResult.diff_text, 'diff')}
                            style={{ background: 'rgba(255,255,255,0.1)', border: '1px solid var(--border)', color: '#fff', padding: '6px 12px', borderRadius: '6px', cursor: 'pointer', fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', transition: '0.2s' }}>
                            {copyStatus === 'diff' ? '✅ Copied!' : '📋 Copy Diff'}
                          </button>
                        )}
                        <button 
                          onClick={() => setDiffResult(null)} 
                          style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer', padding: '4px' }}>
                          ✕
                        </button>
                      </div>
                    </div>
                    
                    {diffResult.is_identical ? (
                      <div style={{ color: 'var(--success)', fontWeight: 'bold', display:'flex', alignItems:'center', gap:'8px', padding: '16px', background: 'rgba(16, 185, 129, 0.1)', borderRadius:'8px', border: '1px solid var(--success)' }}>
                        <span>✅</span> Kedua konfigurasi identik secara garis besar!
                      </div>
                    ) : (
                      <div style={{ background: '#0f1115', borderRadius: '8px', border: '1px solid #1f2937', overflow: 'hidden' }}>
                        <div style={{ background: '#1f2937', padding: '6px 12px', fontSize: '11px', color: '#9ca3af', textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 'bold', display: 'flex', gap: '16px' }}>
                          <span>@@ GitHub Style Tracker</span>
                          <span style={{ color: '#34d399' }}>+ Additions</span>
                          <span style={{ color: '#f87171' }}>- Deletions</span>
                        </div>
                        <div style={{ margin: 0, padding: '16px 0', overflowX: 'auto', maxHeight: '500px' }}>
                          {renderDiffContent(diffResult.diff_text)}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Compliance Engine Sidebar style */}
                <div className="glass-panel" style={{ borderLeft: '4px solid var(--success)' }}>
                  <h3 style={{ marginTop: 0 }}>🛡️ Policy & Baseline Automation</h3>
                  <p style={{ fontSize: '14px', color: 'var(--text-muted)', marginBottom: '16px' }}>Eksekusi pemindaian *Audit* aturan (*Compliance Check*).</p>
                  <div style={{ display: 'flex', gap: '16px' }}>
                    <input type="text" value={complianceRule} onChange={e => setComplianceRule(e.target.value)} placeholder="Contoh: snmp-server community public" style={{ flex: 1, padding: '12px', borderRadius: '8px', border: '1px solid var(--border)', background: 'rgba(0,0,0,0.2)', color: '#fff' }} />
                    <button onClick={handleComplianceCheck} className="btn-primary" style={{ width: 'auto' }}>Pindai Node</button>
                  </div>
                  
                  {complianceResult && (
                    <div style={{ marginTop: '16px', padding: '16px', borderRadius: '8px', background: 'rgba(0,0,0,0.3)', border: `1px solid ${complianceResult.is_compliant ? 'var(--success)' : 'var(--danger)'}` }}>
                      <div style={{ fontWeight: 'bold', fontSize: '18px', color: complianceResult.is_compliant ? 'var(--success)' : 'var(--danger)', marginBottom: '8px' }}>
                        {complianceResult.is_compliant ? '✅ COMPLIANT' : '❌ NON-COMPLIANT'}
                      </div>
                      {!complianceResult.is_compliant && (
                        <ul style={{ color: '#ff9999', paddingLeft: '20px', margin: 0 }}>
                          {complianceResult.missing_rules.map((rule, idx) => (
                            <li key={idx}>Barisan "{rule}" <b>TIDAK DITEMUKAN</b>!</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </div>

              </div>
            )}
          </div>
        )}

        {/* == TAB TOPOLOGY == */}
        {activeTab === 'topology' && (
          <Topology keycloak={keycloakAuth} isAdmin={isAdmin} onNodeClick={(dev) => setMetricsDevice(dev)} />
        )}

        {/* == TAB SYSLOGS == */}
        {activeTab === 'syslogs' && (
          <SystemLogs token={keycloakAuth.token} />
        )}

        {/* == TAB REPORTS == */}
        {activeTab === 'reports' && (
          <ReportsEngine token={keycloakAuth.token} />
        )}

        {/* == TAB ALARMS == */}
        {activeTab === 'alarms' && (
          <div className="glass-panel alarms-module">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
              <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className="pulse-dot" style={{width: '12px', height: '12px', background: '#ef4444', borderRadius: '50%', display: 'inline-block'}}></span>
                Active Escalation Hub
              </h3>
            </div>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr style={{ background: 'rgba(255,255,255,0.05)', textAlign: 'left' }}>
                  <th style={{ padding: '12px' }}>Timestamp</th>
                  <th style={{ padding: '12px' }}>Device ID</th>
                  <th style={{ padding: '12px' }}>Severity</th>
                  <th style={{ padding: '12px' }}>Message</th>
                  <th style={{ padding: '12px' }}>Status</th>
                  <th style={{ padding: '12px', textAlign: 'center' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {activeAlarms.length === 0 ? (
                  <tr><td colSpan="6" style={{ padding: '24px', textAlign: 'center', color: 'var(--success)' }}>All systems green. No active alarms.</td></tr>
                ) : (
                  activeAlarms.map(alarm => (
                    <tr key={alarm.alarm_id} style={{ 
                        borderBottom: '1px solid var(--border)', 
                        background: alarm.status === 'Active' && alarm.severity === 'Critical' ? 'rgba(239, 68, 68, 0.1)' : 'transparent' 
                    }}>
                      <td style={{ padding: '12px' }}>{new Date(alarm.created_at).toLocaleString()}</td>
                      <td style={{ padding: '12px', fontWeight: 'bold' }}>{alarm.device_id}</td>
                      <td style={{ padding: '12px', color: alarm.severity === 'Critical' ? '#ef4444' : '#f59e0b', fontWeight: 'bold' }}>{alarm.severity}</td>
                      <td style={{ padding: '12px' }}>{alarm.message}</td>
                      <td style={{ padding: '12px' }}>
                         {alarm.status === 'Active' ? <span style={{ color: '#ef4444', fontWeight: 'bold' }}>ACTIVE</span> : <span style={{ color: 'var(--text-muted)' }}>Acknowledged by {alarm.acknowledged_by}</span>}
                      </td>
                      <td style={{ padding: '12px', textAlign: 'center' }}>
                        {alarm.status === 'Active' && (
                          <button onClick={() => handleAckAlarm(alarm.alarm_id)} style={{ background: 'var(--primary)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' }}>
                            ACKNOWLEDGE
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* == TAB SETTINGS == */}
        {activeTab === 'settings' && (
          <div className="glass-panel settings-module" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '32px' }}>
            <div style={{ borderRight: '1px solid var(--border)', paddingRight: '32px' }}>
              <h3 style={{ margin: '0 0 24px 0', color: 'var(--primary-hover)' }}>⚙️ Global Engine Configurations</h3>
              <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label>Polling Interval (Seconds)</label>
                  <input type="number" min="10" max="3600" value={systemSettings.polling_interval_sec} onChange={e => setSystemSettings({...systemSettings, polling_interval_sec: parseInt(e.target.value)})} required />
                  <small style={{ color: 'var(--text-muted)' }}>Kecepatan Mesin Poller membaca data TimescaleDB SNMP.</small>
                </div>
                <div>
                  <label>Telegram / Slack Webhook URL</label>
                  <input type="url" value={systemSettings.alert_webhook_url} onChange={e => setSystemSettings({...systemSettings, alert_webhook_url: e.target.value})} placeholder="https://api.telegram.org/bot..." />
                </div>
                <h4 style={{ margin: '8px 0 0 0', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '8px' }}>SMTP Mail Server (Optional)</h4>
                <div>
                  <label>SMTP Host</label>
                  <input type="text" value={systemSettings.smtp_host || ''} onChange={e => setSystemSettings({...systemSettings, smtp_host: e.target.value})} placeholder="mail.company.local" />
                </div>
                <div style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ flex: 1 }}>
                    <label>SMTP Port</label>
                    <input type="number" value={systemSettings.smtp_port || ''} onChange={e => setSystemSettings({...systemSettings, smtp_port: parseInt(e.target.value)})} placeholder="587" />
                  </div>
                  <div style={{ flex: 1 }}>
                    <label>SMTP Username</label>
                    <input type="text" value={systemSettings.smtp_user || ''} onChange={e => setSystemSettings({...systemSettings, smtp_user: e.target.value})} />
                  </div>
                </div>
                <div style={{ marginTop: '16px' }}>
                  <button type="submit" className="btn-primary" disabled={isSavingSettings} style={{ width: '100%', padding: '12px' }}>
                    {isSavingSettings ? 'Saving...' : '💾 Save Configurations'}
                  </button>
                </div>
              </form>
            </div>
            
            <div>
              <h3 style={{ margin: '0 0 24px 0', color: '#10b981' }}>🛡️ IAM & Access Control (Keycloak)</h3>
              <div style={{ background: '#0f1115', padding: '24px', borderRadius: '8px', border: '1px solid #1f2937' }}>
                <div style={{ marginBottom: '16px', display: 'flex', alignItems: 'center', gap: '16px' }}>
                  <div style={{ width: '64px', height: '64px', background: 'var(--primary-color)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '24px', fontWeight: 'bold', color: 'white' }}>
                    {userName.charAt(0).toUpperCase()}
                  </div>
                  <div>
                    <h2 style={{ margin: 0, color: 'white' }}>{fullName}</h2>
                    <div style={{ color: 'var(--success)', fontSize: '14px', marginTop: '4px' }}>SSO Token Valid / Authenticated</div>
                  </div>
                </div>
                <hr style={{ borderColor: 'rgba(255,255,255,0.1)', margin: '16px 0' }} />
                <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: '12px', fontSize: '14px' }}>
                  <div style={{ color: 'var(--text-muted)' }}>Username:</div>
                  <div style={{ color: 'white', fontWeight: 'bold' }}>{keycloakAuth.tokenParsed?.preferred_username}</div>
                  
                  <div style={{ color: 'var(--text-muted)' }}>Email:</div>
                  <div style={{ color: 'white' }}>{keycloakAuth.tokenParsed?.email || 'N/A'}</div>
                  
                  <div style={{ color: 'var(--text-muted)' }}>Session ID:</div>
                  <div style={{ color: 'white', fontFamily: 'monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis' }}>{keycloakAuth.tokenParsed?.session_state}</div>
                  
                  <div style={{ color: 'var(--text-muted)' }}>Account Roles:</div>
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                    {keycloakAuth.tokenParsed?.realm_access?.roles?.filter(r => r !== 'default-roles-nms_realm' && r !== 'offline_access').map(r => (
                      <span key={r} style={{ background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa', padding: '4px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}>
                        {r}
                      </span>
                    )) || <span style={{color: '#666'}}>No standard roles found.</span>}
                  </div>
                </div>
                {isAdmin && (
                   <div style={{ marginTop: '24px', padding: '16px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '8px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                     <span style={{ fontSize: '18px', display: 'block', marginBottom: '8px' }}>🚀 SuperAdmin Privileges Active</span>
                     <p style={{ margin: 0, fontSize: '12px', color: '#fca5a5' }}>Sebagai pemilik hak "admin", Anda dapat merombak pengaturan mesin metrik global, meregistrasikan node otomatis dari Subnet Discovery, dan membungkam System Alarms secara hirarkis.</p>
                   </div>
                )}
              </div>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(error, errorInfo) {
    this.setState({ error: error, errorInfo: errorInfo });
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '40px', color: '#ff4444', backgroundColor: '#111', height: '100vh', fontFamily: 'monospace' }}>
          <h2 style={{color: 'white'}}>Reactor Core Crash 💥</h2>
          <hr />
          <h3 style={{color: 'red'}}>{this.state.error && this.state.error.toString()}</h3>
          <pre style={{ color: '#aaa', marginTop: '20px', whiteSpace: 'pre-wrap' }}>
            {this.state.errorInfo && this.state.errorInfo.componentStack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <MainApp />
    </ErrorBoundary>
  );
}
