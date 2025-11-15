// App.js
import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  PermissionsAndroid,
  Platform,
  Linking,
  Vibration,
  NativeModules,
} from 'react-native';
import Geolocation from '@react-native-community/geolocation';
import { accelerometer } from 'react-native-sensors';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Voice from '@react-native-voice/voice';
import SmsAndroid from 'react-native-sms-x'; // auto-send library
import BluetoothSerial from 'react-native-bluetooth-serial-next';
import Torch from 'react-native-torch';
import AudioRecorderPlayer from 'react-native-audio-recorder-player';
import { Icon } from 'react-native-elements';

const { IntentLauncher } = NativeModules || {}; // optional native launcher fallback

const App = () => {
  const [activeTab, setActiveTab] = useState('home');
  const [contacts, setContacts] = useState([]);
  const [isListening, setIsListening] = useState(false);
  const [location, setLocation] = useState(null);
  const [shakeCount, setShakeCount] = useState(0);
  const [panicMode, setPanicMode] = useState(false);
  const [liveTracking, setLiveTracking] = useState(false);
  const [bluetoothConnected, setBluetoothConnected] = useState(false);
  const [flashlightOn, setFlashlightOn] = useState(false);
  const [recording, setRecording] = useState(false);
  const [autoCallEnabled, setAutoCallEnabled] = useState(true);
  const [primaryContact, setPrimaryContact] = useState(null);
  const [callAttempts, setCallAttempts] = useState(0);

  const locationIntervalRef = useRef(null);
  const shakeTimeoutRef = useRef(null);
  const callRetryRef = useRef(null);
  const audioRecorderPlayer = useRef(new AudioRecorderPlayer()).current;
  const watchIdRef = useRef(null);

  const helplines = [
    { name: "Women Helpline", number: "1091" },
    { name: "National Emergency", number: "112" },
    { name: "Police", number: "100" },
    { name: "Ambulance", number: "102" },
    { name: "Child Helpline", number: "1098" }
  ];

  // When component mounts: request permissions & set up features
  useEffect(() => {
    requestPermissions();
    loadContacts();
    setupVoice();
    const accUnsub = setupAccelerometer();
    setupBluetooth();

    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
      if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
      if (watchIdRef.current) Geolocation.clearWatch(watchIdRef.current);
      if (accUnsub) accUnsub();
    };
  }, []);

  // Request Android runtime permissions
  const requestPermissions = async () => {
    if (Platform.OS === 'android') {
      try {
        const grants = await PermissionsAndroid.requestMultiple([
          PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
          PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
          PermissionsAndroid.PERMISSIONS.CAMERA,
          PermissionsAndroid.PERMISSIONS.SEND_SMS,
          PermissionsAndroid.PERMISSIONS.CALL_PHONE,
          PermissionsAndroid.PERMISSIONS.READ_CONTACTS,
          PermissionsAndroid.PERMISSIONS.WRITE_EXTERNAL_STORAGE,
          PermissionsAndroid.PERMISSIONS.READ_EXTERNAL_STORAGE,
          // For newer Androids these are requested at build/manifest; some may be ignored at runtime:
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
          PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        ]);
        console.log('Permissions result:', grants);
      } catch (err) {
        console.warn('Permission error:', err);
      }
    }
  };

  const loadContacts = async () => {
    try {
      const savedContacts = await AsyncStorage.getItem('emergencyContacts');
      const savedPrimary = await AsyncStorage.getItem('primaryContact');
      const savedAutoCall = await AsyncStorage.getItem('autoCallEnabled');
      
      if (savedContacts) setContacts(JSON.parse(savedContacts));
      if (savedPrimary) setPrimaryContact(JSON.parse(savedPrimary));
      if (savedAutoCall) setAutoCallEnabled(JSON.parse(savedAutoCall));
    } catch (error) {
      console.error('Error loading contacts:', error);
    }
  };

  const saveContacts = async (newContacts) => {
    try {
      await AsyncStorage.setItem('emergencyContacts', JSON.stringify(newContacts));
      setContacts(newContacts);
    } catch (error) {
      console.error('Error saving contacts:', error);
    }
  };

  // Voice Recognition
  const setupVoice = () => {
    Voice.onSpeechResults = (e) => {
      try {
        const transcript = (e.value && e.value[0]) ? e.value[0].toLowerCase() : '';
        if (transcript.includes('help') || transcript.includes('emergency') || transcript.includes('sos')) {
          triggerSOS('voice');
        }
      } catch (err) {
        console.warn('Speech results parse error', err);
      }
    };
  };

  const toggleVoiceListening = async () => {
    try {
      if (isListening) {
        await Voice.stop();
        setIsListening(false);
      } else {
        await Voice.start('en-US');
        setIsListening(true);
      }
    } catch (error) {
      console.error('Voice error:', error);
    }
  };

  // Accelerometer (shake detection)
  const setupAccelerometer = () => {
    const subscription = accelerometer.subscribe(({ x, y, z }) => {
      const acceleration = Math.sqrt(x * x + y * y + z * z);
      if (acceleration > 20) {
        setShakeCount(prev => {
          const newCount = prev + 1;
          clearTimeout(shakeTimeoutRef.current);
          shakeTimeoutRef.current = setTimeout(() => setShakeCount(0), 3000);
          if (newCount >= 5) {
            triggerSOS('shake');
            return 0;
          }
          return newCount;
        });
      }
    });

    return () => subscription.unsubscribe();
  };

  // Bluetooth setup & SOS listener
  const setupBluetooth = async () => {
    try {
      const enabled = await BluetoothSerial.isEnabled();
      if (enabled) {
        // When connection lost -> trigger
        BluetoothSerial.on('connectionLost', () => {
          setBluetoothConnected(false);
          triggerSOS('bluetooth disconnect');
        });

        // data listener — when wearable sends "SOS"
        BluetoothSerial.on('read', (data) => {
          try {
            const msg = (data && data.data) ? data.data.trim() : data.trim();
            if (msg === 'SOS' || msg.toUpperCase() === 'SOS') {
              triggerSOS('wearable SOS');
            }
          } catch (err) {
            console.warn('Bluetooth read parse error', err);
          }
        });
      }
    } catch (error) {
      console.error('Bluetooth setup error:', error);
    }
  };

  const connectBluetooth = async () => {
    try {
      const devices = await BluetoothSerial.list();
      if (devices.length > 0) {
        await BluetoothSerial.connect(devices[0].id);
        setBluetoothConnected(true);
        Alert.alert('Success', `Connected to ${devices[0].name}`);
      } else {
        Alert.alert('No Devices', 'No Bluetooth devices found');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to connect to Bluetooth device');
    }
  };

  // Location helper
  const getCurrentLocation = () => {
    return new Promise((resolve, reject) => {
      Geolocation.getCurrentPosition(
        position => {
          const loc = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            timestamp: new Date().toISOString()
          };
          setLocation(loc);
          resolve(loc);
        },
        error => reject(error),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
      );
    });
  };

  const startLiveTracking = () => {
    setLiveTracking(true);
    locationIntervalRef.current = setInterval(async () => {
      try {
        const loc = await getCurrentLocation();
        sendLiveLocation(loc);
      } catch (error) {
        console.error('Live tracking error', error);
      }
    }, 10000);
  };

  const stopLiveTracking = () => {
    setLiveTracking(false);
    if (locationIntervalRef.current) clearInterval(locationIntervalRef.current);
  };

  // --- SMS: silent attempt using SmsAndroid.autoSend + fallback to composer ---
  const sendSMS = async (phone, message) => {
    try {
      SmsAndroid.autoSend(
        phone,
        message,
        (fail) => {
          console.warn('SmsAndroid autoSend failed:', fail);
          // Fallback: open SMS composer so user can send manually
          try {
            const url = `sms:${phone}?body=${encodeURIComponent(message)}`;
            Linking.openURL(url);
            Alert.alert('SMS Not Sent Silently', 'Auto-send failed on this device. SMS composer opened — please press Send.');
          } catch (err) {
            console.error('Fallback sms composer error', err);
            Alert.alert(
              'SMS Failed',
              'Unable to send SMS automatically and failed to open composer. Please check permissions or set this app as default SMS app.'
            );
          }
        },
        (success) => {
          console.log(`SMS auto-sent to ${phone}`, success);
        }
      );
    } catch (error) {
      console.error('Sms send exception', error);
      // Final fallback
      try {
        const url = `sms:${phone}?body=${encodeURIComponent(message)}`;
        Linking.openURL(url);
        Alert.alert('SMS Fallback', 'Auto-send had an exception; SMS composer opened for manual send.');
      } catch (err) {
        console.error('Final fallback error', err);
        Alert.alert('SMS Error', 'Failed to send or open SMS composer.');
      }
    }
  };

  const sendLiveLocation = (loc) => {
    const googleMapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
    const message = `🚨 SOS Alert! I am in danger.
Location: ${googleMapsLink}
Time: ${new Date(loc.timestamp).toLocaleString()}
Accuracy: ${loc.accuracy ? loc.accuracy.toFixed(0) : 'N/A'}m
Please help immediately.`;
    
    contacts.forEach(contact => sendSMS(contact.phone, message));
  };

  // Emergency calling + escalation
  const makeEmergencyCall = (contact, attempt) => {
    if (!contact) return;
    if (attempt >= 3) {
      const secondaryContact = contacts.find(c => c.id !== contact.id);
      if (secondaryContact) {
        makeEmergencyCall(secondaryContact, 0);
      }
      return;
    }

    setCallAttempts(attempt + 1);
    try {
      Linking.openURL(`tel:${contact.phone}`);
    } catch (err) {
      console.error('Call error: ', err);
    }

    callRetryRef.current = setTimeout(() => {
      if (panicMode) makeEmergencyCall(contact, attempt + 1);
    }, 30000);
  };

  // Start/stop recording
  const startRecording = async () => {
    try {
      const path = `${AudioRecorderPlayer.DEFAULT_PATH}/emergency_${Date.now()}.mp4`;
      await audioRecorderPlayer.startRecorder(path);
      setRecording(true);
    } catch (error) {
      console.error('Recording start error', error);
    }
  };

  const stopRecording = async () => {
    try {
      await audioRecorderPlayer.stopRecorder();
      setRecording(false);
    } catch (error) {
      console.error('Recording stop error', error);
    }
  };

  // Flashlight
  const toggleFlashlight = async (forceState = null) => {
    try {
      const newState = forceState !== null ? forceState : !flashlightOn;
      await Torch.switchState(newState);
      setFlashlightOn(newState);
    } catch (error) {
      console.error('Flash error', error);
    }
  };

  // SOS trigger
  const triggerSOS = async (source) => {
    if (contacts.length === 0) {
      Alert.alert('No Contacts', 'Please add emergency contacts first!');
      setActiveTab('settings');
      return;
    }

    setPanicMode(true);
    Vibration.vibrate([0, 500, 200, 500]);

    try {
      const loc = await getCurrentLocation();
      startLiveTracking();
      startRecording();
      toggleFlashlight(true);

      const googleMapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
      const message = `🚨 EMERGENCY SOS ALERT! 🚨

I NEED IMMEDIATE HELP!

⚠️ Trigger: ${source}
🕐 Time: ${new Date().toLocaleString()}

📍 LIVE LOCATION:
${googleMapsLink}

Live tracking is now ACTIVE. You will receive location updates every 10 seconds.

⚠️ PLEASE CONTACT ME OR CALL AUTHORITIES IMMEDIATELY!

This is an automated emergency message from W-Safe Pro.`;

      contacts.forEach(contact => sendSMS(contact.phone, message));

      if (autoCallEnabled && contacts.length > 0) {
        const primary = primaryContact || contacts[0];
        makeEmergencyCall(primary, 0);
      }

      Alert.alert(
        '🚨 EMERGENCY ACTIVATED!',
        `✅ SOS SMS queued/sent to ${contacts.length} contact(s)
✅ Live location tracking started
✅ Google Maps link included
${autoCallEnabled ? '✅ Emergency call initiated' : ''}
✅ Recording activated
✅ Flashlight enabled`
      );
    } catch (error) {
      console.error('Trigger SOS error', error);
      Alert.alert('Error', 'Failed to activate emergency. Please try again.');
    }
  };

  const stopPanicMode = async () => {
    setPanicMode(false);
    stopLiveTracking();
    stopRecording();
    toggleFlashlight(false);
    setCallAttempts(0);
    if (callRetryRef.current) clearTimeout(callRetryRef.current);

    const loc = location || await getCurrentLocation();
    const googleMapsLink = `https://maps.google.com/?q=${loc.lat},${loc.lng}`;
    const message = `✅ PANIC MODE DEACTIVATED

User has safely deactivated the emergency alert.

🕐 Time: ${new Date().toLocaleString()}
📍 Final Location: ${googleMapsLink}

Emergency has been resolved.`;

    contacts.forEach(contact => sendSMS(contact.phone, message));
    Alert.alert('Deactivated', 'Panic mode stopped. Contacts have been notified.');
  };

  // Contact handlers (simple prompts)
  const addContact = () => {
    // For simplicity in code, use a pair of prompts (native Alert.prompt available only on iOS).
    // For Android, you'd normally use a custom modal. Here we use a simplified flow via prompt fallback.
    Alert.alert(
      'Add Contact',
      'Open Settings -> Contacts screen to add contacts in the UI (for demo).',
      [{ text: 'OK' }]
    );
    // In your production app replace with a proper modal to capture name + phone number.
  };

  const removeContact = async (id) => {
    const updated = contacts.filter(c => c.id !== id);
    await saveContacts(updated);
    if (primaryContact?.id === id && updated.length > 0) {
      setPrimaryContact(updated[0]);
      await AsyncStorage.setItem('primaryContact', JSON.stringify(updated[0]));
    }
  };

  const setPrimary = async (contact) => {
    setPrimaryContact(contact);
    await AsyncStorage.setItem('primaryContact', JSON.stringify(contact));
    Alert.alert('Success', `${contact.name} is now your PRIMARY emergency contact.`);
  };

  const findNearby = (type) => {
    if (location) {
      const searchQuery = type === 'police' ? 'police+station' : 'hospital';
      Linking.openURL(`https://www.google.com/maps/search/${searchQuery}/@${location.lat},${location.lng},15z`);
    } else {
      Alert.alert('Location Required', 'Please enable location services!');
    }
  };

  const callHelpline = (number) => {
    Linking.openURL(`tel:${number}`);
  };

  // UI (keeps your original style & structure)
  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <Icon name="shield" type="feather" color="#fff" size={32} />
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>W-Safe Pro</Text>
            <Text style={styles.headerSubtitle}>Enhanced Protection</Text>
          </View>
        </View>
        <View style={styles.headerStatus}>
          {bluetoothConnected && (
            <View style={styles.statusBadge}>
              <Icon name="bluetooth" type="feather" color="#fff" size={16} />
              <Text style={styles.statusText}>Connected</Text>
            </View>
          )}
          {liveTracking && (
            <View style={[styles.statusBadge, styles.liveBadge]}>
              <Icon name="activity" type="feather" color="#fff" size={16} />
              <Text style={styles.statusText}>LIVE</Text>
            </View>
          )}
        </View>
      </View>

      {shakeCount > 0 && (
        <View style={styles.shakeAlert}>
          <Text style={styles.shakeText}>Shake Detected: {shakeCount}/5</Text>
        </View>
      )}

      <ScrollView style={styles.content}>
        {activeTab === 'home' && (
          <View style={styles.tabContent}>
            {panicMode && (
              <View style={styles.panicBanner}>
                <View style={styles.panicHeader}>
                  <View style={styles.panicInfo}>
                    <Icon name="alert-circle" type="feather" color="#fff" size={24} />
                    <View>
                      <Text style={styles.panicTitle}>PANIC MODE ACTIVE</Text>
                      <Text style={styles.panicSubtitle}>Live tracking enabled</Text>
                      {callAttempts > 0 && (
                        <Text style={styles.panicCall}>Call attempt: {callAttempts}/3</Text>
                      )}
                    </View>
                  </View>
                  <TouchableOpacity style={styles.stopButton} onPress={stopPanicMode}>
                    <Text style={styles.stopButtonText}>Stop</Text>
                  </TouchableOpacity>
                </View>
              </View>
            )}

            <View style={styles.panicButtonContainer}>
              <Text style={styles.sectionTitle}>Emergency Actions</Text>
              <TouchableOpacity
                style={[styles.panicButton, panicMode && styles.panicButtonActive]}
                onPress={() => triggerSOS('panic button')}
                disabled={panicMode}
              >
                <Icon name="alert-circle" type="feather" color="#fff" size={80} />
                <Text style={styles.panicButtonText}>SOS</Text>
                <Text style={styles.panicButtonSubtext}>
                  {panicMode ? 'ACTIVE' : 'PANIC BUTTON'}
                </Text>
              </TouchableOpacity>
              <Text style={styles.panicHint}>
                {panicMode ? 'Emergency mode is active' : 'Press for immediate alert'}
              </Text>
            </View>

            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Icon name="bluetooth" type="feather" color="#2563eb" size={32} />
                <View style={styles.cardHeaderText}>
                  <Text style={styles.cardTitle}>Bluetooth Auto-Alert</Text>
                  <Text style={styles.cardSubtitle}>ESP32 Wearable Protection</Text>
                </View>
              </View>
              <Text style={styles.cardDescription}>
                Connect your ESP32 wearable. If Bluetooth disconnects, automatic SOS triggers instantly.
              </Text>
              {bluetoothConnected ? (
                <View>
                  <View style={styles.connectedBadge}>
                    <Icon name="shield" type="feather" color="#059669" size={20} />
                    <Text style={styles.connectedText}>Protected</Text>
                  </View>
                  <TouchableOpacity
                    style={styles.disconnectButton}
                    onPress={() => {
                      BluetoothSerial.disconnect();
                      setBluetoothConnected(false);
                    }}
                  >
                    <Text style={styles.buttonText}>Disconnect Device</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <TouchableOpacity style={styles.connectButton} onPress={connectBluetooth}>
                  <Text style={styles.buttonText}>Connect Wearable Device</Text>
                </TouchableOpacity>
              )}
            </View>

            <View style={styles.quickActions}>
              <TouchableOpacity
                style={[styles.quickAction, isListening && styles.quickActionActive]}
                onPress={toggleVoiceListening}
              >
                <Icon name="mic" type="feather" color={isListening ? '#fff' : '#ec4899'} size={32} />
                <Text style={[styles.quickActionText, isListening && styles.quickActionTextActive]}>
                  {isListening ? 'Listening' : 'Voice SOS'}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.quickAction, liveTracking && styles.quickActionActive]}
                onPress={() => liveTracking ? stopLiveTracking() : startLiveTracking()}
              >
                <Icon name="map-pin" type="feather" color={liveTracking ? '#fff' : '#ec4899'} size={32} />
                <Text style={[styles.quickActionText, liveTracking && styles.quickActionTextActive]}>
                  {liveTracking ? 'Tracking' : 'Live Track'}
                </Text>
              </TouchableOpacity>
            </View>

            <View style={styles.tools}>
              <TouchableOpacity
                style={[styles.tool, flashlightOn && styles.toolActive]}
                onPress={() => toggleFlashlight()}
              >
                <Icon name="zap" type="feather" color={flashlightOn ? '#fff' : '#eab308'} size={24} />
                <Text style={styles.toolText}>{flashlightOn ? 'ON' : 'Flash'}</Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.tool, recording && styles.toolRecording]}
                onPress={() => recording ? stopRecording() : startRecording()}
              >
                <Icon name="camera" type="feather" color={recording ? '#fff' : '#ef4444'} size={24} />
                <Text style={styles.toolText}>{recording ? 'Recording' : 'Record'}</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.tool} onPress={() => findNearby('police')}>
                <Icon name="shield" type="feather" color="#3b82f6" size={24} />
                <Text style={styles.toolText}>Police</Text>
              </TouchableOpacity>

              <TouchableOpacity style={styles.tool} onPress={() => findNearby('hospital')}>
                <Icon name="navigation" type="feather" color="#ef4444" size={24} />
                <Text style={styles.toolText}>Hospital</Text>
              </TouchableOpacity>
            </View>

            <View style={styles.card}>
              <Text style={styles.cardTitle}>Emergency Helplines</Text>
              {helplines.map((helpline, idx) => (
                <TouchableOpacity
                  key={idx}
                  style={styles.helplineButton}
                  onPress={() => callHelpline(helpline.number)}
                >
                  <View style={styles.helplineInfo}>
                    <Icon name="phone" type="feather" color="#ec4899" size={20} />
                    <Text style={styles.helplineName}>{helpline.name}</Text>
                  </View>
                  <Text style={styles.helplineNumber}>{helpline.number}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        )}

        {activeTab === 'settings' && (
          <View style={styles.tabContent}>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Emergency Contacts</Text>
              
              <View style={styles.autoCallInfo}>
                <Text style={styles.autoCallTitle}>Auto-Call Feature</Text>
                <Text style={styles.autoCallDescription}>
                  Automatically calls primary contact when SOS is triggered. Retries 3 times, then escalates.
                </Text>
                <TouchableOpacity
                  style={styles.checkboxContainer}
                  onPress={async () => {
                    const newValue = !autoCallEnabled;
                    setAutoCallEnabled(newValue);
                    await AsyncStorage.setItem('autoCallEnabled', JSON.stringify(newValue));
                  }}
                >
                  <Icon
                    name={autoCallEnabled ? 'check-square' : 'square'}
                    type="feather"
                    color="#ec4899"
                    size={24}
                  />
                  <Text style={styles.checkboxLabel}>Enable Automatic Emergency Calling</Text>
                </TouchableOpacity>
              </View>

              <TouchableOpacity style={styles.addButton} onPress={addContact}>
                <Text style={styles.buttonText}>+ Add Emergency Contact</Text>
              </TouchableOpacity>

              {contacts.length === 0 ? (
                <Text style={styles.emptyText}>No emergency contacts added yet</Text>
              ) : (
                contacts.map(contact => (
                  <View
                    key={contact.id}
                    style={[
                      styles.contactCard,
                      primaryContact?.id === contact.id && styles.primaryContactCard
                    ]}
                  >
                    <View style={styles.contactInfo}>
                      <Icon
                        name="user"
                        type="feather"
                        color={primaryContact?.id === contact.id ? '#059669' : '#ec4899'}
                        size={24}
                      />
                      <View style={styles.contactDetails}>
                        <View style={styles.contactNameRow}>
                          <Text style={styles.contactName}>{contact.name}</Text>
                          {primaryContact?.id === contact.id && (
                            <View style={styles.primaryBadge}>
                              <Text style={styles.primaryBadgeText}>PRIMARY</Text>
                            </View>
                          )}
                        </View>
                        <Text style={styles.contactPhone}>{contact.phone}</Text>
                      </View>
                    </View>
                    <View style={styles.contactActions}>
                      {primaryContact?.id !== contact.id && (
                        <TouchableOpacity onPress={() => setPrimary(contact)}>
                          <Text style={styles.setPrimaryText}>Set Primary</Text>
                        </TouchableOpacity>
                      )}
                      <TouchableOpacity onPress={() => removeContact(contact.id)}>
                        <Text style={styles.removeText}>Remove</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                ))
              )}
            </View>
          </View>
        )}
      </ScrollView>

      <View style={styles.bottomNav}>
        <TouchableOpacity
          style={styles.navButton}
          onPress={() => setActiveTab('home')}
        >
          <Icon
            name="shield"
            type="feather"
            color={activeTab === 'home' ? '#ec4899' : '#9ca3af'}
            size={24}
          />
          <Text style={[styles.navText, activeTab === 'home' && styles.navTextActive]}>
            Home
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.navButton}
          onPress={() => setActiveTab('settings')}
        >
          <Icon
            name="settings"
            type="feather"
            color={activeTab === 'settings' ? '#ec4899' : '#9ca3af'}
            size={24}
          />
          <Text style={[styles.navText, activeTab === 'settings' && styles.navTextActive]}>
            Settings
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

// Styles object — keep the same styling you used earlier (copied here)
const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fef2f2',
  },
  header: {
    backgroundColor: '#ec4899',
    padding: 16,
    paddingTop: 40,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerText: {
    marginLeft: 12,
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#fff',
    opacity: 0.9,
  },
  headerStatus: {
    flexDirection: 'row',
    gap: 8,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 16,
    gap: 4,
  },
  liveBadge: {
    backgroundColor: '#10b981',
  },
  statusText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  shakeAlert: {
    backgroundColor: '#fff',
    padding: 12,
    alignItems: 'center',
  },
  shakeText: {
    color: '#ec4899',
    fontWeight: 'bold',
    fontSize: 16,
  },
  content: {
    flex: 1,
  },
  tabContent: {
    padding: 16,
  },
  panicBanner: {
    backgroundColor: '#dc2626',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
  },
  panicHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  panicInfo: {
    flexDirection: 'row',
    gap: 12,
    flex: 1,
  },
  panicTitle: {
    color: '#fff',
    fontWeight: 'bold',
    fontSize: 18,
  },
  panicSubtitle: {
    color: '#fff',
    fontSize: 14,
  },
  panicCall: {
    color: '#fff',
    fontSize: 12,
    marginTop: 4,
  },
  stopButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 8,
  },
  stopButtonText: {
    color: '#dc2626',
    fontWeight: 'bold',
  },
  panicButtonContainer: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 32,
    alignItems: 'center',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 24,
  },
  panicButton: {
    width: 192,
    height: 192,
    borderRadius: 96,
    backgroundColor: '#dc2626',
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 8,
  },
  panicButtonActive: {
    backgroundColor: '#9ca3af',
  },
  panicButtonText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: 'bold',
    marginTop: 8,
  },
  panicButtonSubtext: {
    color: '#fff',
    fontSize: 14,
  },
  panicHint: {
    color: '#6b7280',
    textAlign: 'center',
    marginTop: 16,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginBottom: 16,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
  },
  cardHeaderText: {
    marginLeft: 12,
    flex: 1,
  },
  cardTitle: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#1f2937',
    marginBottom: 8,
  },
  cardSubtitle: {
    fontSize: 14,
    color: '#6b7280',
  },
  cardDescription: {
    color: '#4b5563',
    fontSize: 14,
    marginBottom: 16,
  },
  connectedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#d1fae5',
    borderWidth: 1,
    borderColor: '#6ee7b7',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  connectedText: {
    color: '#059669',
    fontWeight: '600',
    marginLeft: 8,
  },
  connectButton: {
    backgroundColor: '#2563eb',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  disconnectButton: {
    backgroundColor: '#ef4444',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
  quickActions: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 16,
  },
  quickAction: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  quickActionActive: {
    backgroundColor: '#10b981',
  },
  quickActionText: {
    color: '#ec4899',
    fontWeight: '600',
    marginTop: 8,
  },
  quickActionTextActive: {
    color: '#fff',
  },
  tools: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16,
  },
  tool: {
    flex: 1,
    backgroundColor: '#fff',
    borderRadius: 12,
    padding: 12,
    alignItems: 'center',
  },
  toolActive: {
    backgroundColor: '#fbbf24',
  },
  toolRecording: {
    backgroundColor: '#ef4444',
  },
  toolText: {
    fontSize: 12,
    fontWeight: '600',
    marginTop: 4,
  },
  helplineButton: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: '#fce7f3',
    padding: 12,
    borderRadius: 8,
    marginBottom: 8,
  },
  helplineInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  helplineName: {
    fontWeight: '600',
    color: '#1f2937',
  },
  helplineNumber: {
    color: '#ec4899',
    fontWeight: 'bold',
    fontSize: 16,
  },
  autoCallInfo: {
    backgroundColor: '#dbeafe',
    padding: 16,
    borderRadius: 8,
    marginBottom: 16,
  },
  autoCallTitle: {
    fontWeight: 'bold',
    color: '#1e40af',
    marginBottom: 8,
  },
  autoCallDescription: {
    fontSize: 14,
    color: '#1e3a8a',
    marginBottom: 12,
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  checkboxLabel: {
    fontWeight: '600',
    color: '#1f2937',
    flex: 1,
  },
  addButton: {
    backgroundColor: '#ec4899',
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 16,
  },
  emptyText: {
    textAlign: 'center',
    color: '#6b7280',
    paddingVertical: 32,
  },
  contactCard: {
    backgroundColor: '#f9fafb',
    padding: 12,
    borderRadius: 8,
    marginBottom: 12,
  },
  primaryContactCard: {
    backgroundColor: '#d1fae5',
    borderWidth: 2,
    borderColor: '#10b981',
  },
  contactInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  contactDetails: {
    marginLeft: 12,
    flex: 1,
  },
  contactNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  contactName: {
    fontWeight: '600',
    color: '#1f2937',
  },
  primaryBadge: {
    backgroundColor: '#059669',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 12,
  },
  primaryBadgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  contactPhone: {
    fontSize: 14,
    color: '#6b7280',
  },
  contactActions: {
    flexDirection: 'row',
    gap: 16,
  },
  setPrimaryText: {
    color: '#10b981',
    fontWeight: '600',
  },
  removeText: {
    color: '#ef4444',
    fontWeight: '600',
  },
  bottomNav: {
    flexDirection: 'row',
    backgroundColor: '#fff',
    borderTopWidth: 1,
    borderTopColor: '#e5e7eb',
    paddingVertical: 8,
  },
  navButton: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
  },
  navText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9ca3af',
    marginTop: 4,
  },
  navTextActive: {
    color: '#ec4899',
  },
});

export default App;
