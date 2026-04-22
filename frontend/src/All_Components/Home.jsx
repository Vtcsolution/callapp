import { MessageCircle, User, Phone, Star, Shield, Sparkles, Users, Clock, Heart, Globe, Award, Zap, CheckCircle, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useNavigate } from "react-router-dom";
import { useEffect, useState, useRef, useCallback } from "react";
import axios from "axios";
import { toast } from "sonner";
import { useAuth } from "./screen/AuthContext";
import { motion } from "framer-motion";
import io from 'socket.io-client';

const Home = () => {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const [humanPsychics, setHumanPsychics] = useState([]);
  const [showing, setShowing] = useState(6);
  const [isLoadingHumanPsychics, setIsLoadingHumanPsychics] = useState(false);
  const [humanPsychicsError, setHumanPsychicsError] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [psychicStatuses, setPsychicStatuses] = useState({});
  const [ratingSummaries, setRatingSummaries] = useState({});
  const socketRef = useRef(null);
  const [socketConnected, setSocketConnected] = useState(false);
  // Track which psychic IDs we have already subscribed to
  const subscribedPsychicsRef = useRef(new Set());
  // Track latest psychicIds to use inside socket callbacks without stale closures
  const humanPsychicIdsRef = useRef([]);

  const [homeContent, setHomeContent] = useState(null);
  const [contentLoading, setContentLoading] = useState(true);

  const [colors, setColors] = useState({
    deepPurple: "#2B1B3F",
    antiqueGold: "#C9A24D",
    softIvory: "#F5F3EB",
    lightGold: "#E8D9B0",
    darkPurple: "#1A1129",
  });

  // ─── FIX 1: Keep humanPsychicIdsRef in sync so socket callbacks always
  //            have the latest list without triggering re-renders ───────────
  useEffect(() => {
    humanPsychicIdsRef.current = humanPsychics.map(p => p._id).filter(Boolean);
  }, [humanPsychics]);

  // Fetch home page content from CMS
  useEffect(() => {
    const fetchHomeContent = async () => {
      try {
        setContentLoading(true);
        const response = await axios.get(`${import.meta.env.VITE_BASE_URL}/api/home`);
        if (response.data.success) {
          setHomeContent(response.data.data);
          if (response.data.data.colors) {
            setColors(response.data.data.colors);
          }
        }
      } catch (error) {
        console.error('Error fetching home content:', error);
      } finally {
        setContentLoading(false);
      }
    };
    fetchHomeContent();
  }, []);

  // Fetch psychic rating summary
  const fetchPsychicRatingSummary = async (psychicId) => {
    try {
      const endpoints = [
        `${import.meta.env.VITE_BASE_URL}/api/psychic/${psychicId}/summary`,
        `${import.meta.env.VITE_BASE_URL}/api/ratings/psychic/${psychicId}/summary`,
        `${import.meta.env.VITE_BASE_URL}/api/human-psychics/${psychicId}/summary`
      ];
      for (const endpoint of endpoints) {
        try {
          const response = await axios.get(endpoint, { timeout: 3000 });
          if (response.data && response.data.success) return response.data.data;
        } catch (err) { /* try next */ }
      }
      return null;
    } catch (error) {
      return null;
    }
  };

  // Fetch human psychics
  useEffect(() => {
    const fetchHumanPsychicsWithFastStatus = async () => {
      setIsLoadingHumanPsychics(true);
      setHumanPsychicsError(null);
      try {
        const token = localStorage.getItem("accessToken");
        const response = await axios.get(
          `${import.meta.env.VITE_BASE_URL}/api/human-psychics?all=true`,
          {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            withCredentials: true,
          }
        );

        const data = response.data;
        if (data.success && Array.isArray(data.psychics)) {
          const formattedPsychics = data.psychics.map(p => ({
            ...p,
            isHuman: true,
            type: p.type || "Human Psychic"
          }));

          // Fetch rating summaries
          const summaries = await Promise.all(
            formattedPsychics.map(async (psychic) => ({
              psychicId: psychic._id,
              summary: await fetchPsychicRatingSummary(psychic._id)
            }))
          );
          const summaryMap = {};
          summaries.forEach(item => {
            if (item.summary) summaryMap[item.psychicId] = item.summary;
          });
          setRatingSummaries(prev => ({ ...prev, ...summaryMap }));
          setHumanPsychics(formattedPsychics);

          // Fetch initial HTTP statuses (fallback / first-paint)
          const psychicIds = data.psychics.map(p => p._id);
          if (psychicIds.length > 0) {
            try {
              const statusResponse = await axios.post(
                `${import.meta.env.VITE_BASE_URL}/api/human-psychics/statuses-fast`,
                { psychicIds },
                {
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                  timeout: 2000
                }
              );
              if (statusResponse.data.success) {
                const newStatuses = {};
                Object.keys(statusResponse.data.statuses).forEach(id => {
                  newStatuses[id] = {
                    status: statusResponse.data.statuses[id].status,
                    lastSeen: statusResponse.data.statuses[id].lastSeen,
                    lastActive: statusResponse.data.statuses[id].lastActive,
                    lastUpdate: Date.now()
                  };
                });
                setPsychicStatuses(prev => ({ ...prev, ...newStatuses }));
              }
            } catch (statusError) {
              console.warn("Initial HTTP status fetch failed:", statusError);
            }
          }
        } else {
          throw new Error(data.message || "Failed to fetch human psychics");
        }
      } catch (error) {
        setHumanPsychicsError(error.response?.data?.message || "Failed to load human psychic profiles.");
        toast.error(error.response?.data?.message || "Failed to load human psychic profiles.");
      } finally {
        setIsLoadingHumanPsychics(false);
      }
    };
    fetchHumanPsychicsWithFastStatus();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  // FIX 2: Socket connection
  //   • Connect regardless of whether the user is logged in (guests need
  //     real-time statuses too).
  //   • Join `psychic_list_status` immediately on connect.
  //   • Subscribe/request statuses for ANY psychics already loaded at the
  //     time the socket connects, AND whenever new psychics arrive while
  //     the socket is already connected.
  // ─────────────────────────────────────────────────────────────────────────
  useEffect(() => {
    // Already connected – nothing to do
    if (socketRef.current?.connected) return;

    const token = localStorage.getItem('accessToken');
    const userId = user?._id || 'guest_' + Math.random().toString(36).slice(2);

    console.log('🔄 Creating socket connection...');

    const newSocket = io(`${import.meta.env.VITE_BASE_URL}`, {
      auth: { token, userId, role: 'user' },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      timeout: 20000,
    });

    socketRef.current = newSocket;

    newSocket.on('connect', () => {
      console.log('✅ Socket connected:', newSocket.id);
      setSocketConnected(true);

      // Always join the global broadcast room
      newSocket.emit('join_room', 'psychic_list_status');

      // Subscribe to any psychics already loaded
      const ids = humanPsychicIdsRef.current;
      if (ids.length > 0) {
        subscribeToStatuses(newSocket, ids);
      }
    });

    newSocket.on('disconnect', (reason) => {
      console.log('❌ Socket disconnected:', reason);
      setSocketConnected(false);
      subscribedPsychicsRef.current.clear(); // Allow re-subscribe on reconnect
    });

    newSocket.on('connect_error', (error) => {
      console.error('Socket connection error:', error);
      setSocketConnected(false);
    });

    // ─── Unified status update handler ───────────────────────────────────
    const handlePsychicStatusUpdate = (data) => {
      if (!data?.psychicId) return;
      console.log('🔄 Status update:', data.psychicId, '->', data.status);
      setPsychicStatuses(prev => ({
        ...prev,
        [data.psychicId]: {
          status: data.status,
          lastSeen: data.lastSeen,
          lastActive: data.lastActive,
          lastUpdate: Date.now(),
          isOnline: data.status === 'online'
        }
      }));
    };

    newSocket.on('psychic_status_changed', handlePsychicStatusUpdate);
    newSocket.on('psychic_status_update', handlePsychicStatusUpdate);
    newSocket.on('psychic_online', handlePsychicStatusUpdate);

    // Bulk status response (from get_psychic_statuses / initial send)
    newSocket.on('psychic_statuses_response', (data) => {
      console.log('📋 Bulk statuses received:', Object.keys(data.statuses || {}).length);
      if (data.statuses && !data.error) {
        setPsychicStatuses(prev => {
          const updated = { ...prev };
          Object.keys(data.statuses).forEach(psychicId => {
            updated[psychicId] = {
              status: data.statuses[psychicId].status || 'offline',
              lastSeen: data.statuses[psychicId].lastSeen,
              lastActive: data.statuses[psychicId].lastActive,
              lastUpdate: Date.now(),
              isOnline: data.statuses[psychicId].status === 'online'
            };
          });
          return updated;
        });
      }
    });

    return () => {
      console.log('🧹 Cleaning up socket');
      newSocket.off('psychic_status_changed', handlePsychicStatusUpdate);
      newSocket.off('psychic_status_update', handlePsychicStatusUpdate);
      newSocket.off('psychic_online', handlePsychicStatusUpdate);
      newSocket.off('psychic_statuses_response');
      newSocket.disconnect();
      socketRef.current = null;
      subscribedPsychicsRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // ─── Helper: subscribe to a list of psychic IDs ──────────────────────────
  const subscribeToStatuses = (socket, ids) => {
    const newIds = ids.filter(id => !subscribedPsychicsRef.current.has(id));
    if (newIds.length === 0) return;

    console.log('📊 Subscribing to', newIds.length, 'psychic statuses');

    socket.emit('subscribe_to_psychic_status', { psychicIds: newIds });
    socket.emit('get_psychic_statuses', { psychicIds: newIds });

    newIds.forEach(id => subscribedPsychicsRef.current.add(id));
  };

  // ─── FIX 3: When psychics load AFTER socket is already connected,
  //            subscribe immediately ─────────────────────────────────────────
  useEffect(() => {
    if (!socketConnected || !socketRef.current || humanPsychics.length === 0) return;
    subscribeToStatuses(socketRef.current, humanPsychicIdsRef.current);
  }, [socketConnected, humanPsychics]);

  // ─── FIX 4: Periodic refresh every 60 s ──────────────────────────────────
  useEffect(() => {
    if (!socketConnected || !socketRef.current) return;

    const interval = setInterval(() => {
      const ids = humanPsychicIdsRef.current;
      if (ids.length > 0 && socketRef.current?.connected) {
        console.log('🔁 Periodic status refresh');
        socketRef.current.emit('get_psychic_statuses', { psychicIds: ids });
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [socketConnected]);

  // ─────────────────────────────────────────────────────────────────────────

  const getPsychicStatus = (psychicId) => {
    const statusData = psychicStatuses[psychicId];
    if (!statusData) return 'offline';

    if (statusData.status === 'online' && statusData.lastUpdate) {
      const minutesSinceUpdate = (Date.now() - statusData.lastUpdate) / (1000 * 60);
      if (minutesSinceUpdate > 2) return 'away';
    }

    return statusData.status || 'offline';
  };

  const getStatusBadgeColor = (status) => {
    switch (status) {
      case 'online': return 'bg-emerald-500 text-white';
      case 'away': return 'bg-yellow-500 text-white';
      case 'busy': return 'bg-orange-500 text-white';
      default: return 'bg-gray-400 text-white';
    }
  };

  const getStatusText = (status) => {
    switch (status) {
      case 'online': return 'Online';
      case 'away': return 'Away';
      case 'busy': return 'Busy';
      default: return 'Offline';
    }
  };

  const getStatusIcon = (status) => {
    switch (status) {
      case 'online': return <div className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />;
      case 'away': return <div className="h-2 w-2 rounded-full bg-yellow-500" />;
      case 'busy': return <div className="h-2 w-2 rounded-full bg-orange-500" />;
      default: return <div className="h-2 w-2 rounded-full bg-gray-400" />;
    }
  };

  const isPsychicAvailable = (psychicId) => {
    const status = getPsychicStatus(psychicId);
    return status === 'online' || status === 'away';
  };

  const handleShowMore = () => navigate("/psychics");

  const handlePsychicSelect = async (psychic) => {
    if (!user) {
      toast.error("Please log in to connect with a psychic");
      navigate("/login");
      return;
    }

    const psychicStatus = getPsychicStatus(psychic._id);
    if (psychicStatus === 'offline' || psychicStatus === 'busy') {
      toast.error(`This psychic is currently ${psychicStatus}. Please try again later.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem("accessToken");

      try {
        const check = await axios.get(
          `${import.meta.env.VITE_BASE_URL}/api/humanchat/sessions/check/${psychic._id}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (check.data.exists) {
          navigate(`/message/${psychic._id}`, {
            state: { chatSession: check.data.session, psychic, fromHome: true, timestamp: Date.now() }
          });
          return;
        }
      } catch (_) { /* no existing session */ }

      const response = await axios.post(
        `${import.meta.env.VITE_BASE_URL}/api/humanchat/sessions`,
        { psychicId: psychic._id },
        { headers: { Authorization: `Bearer ${token}` } }
      );

      if (response.data.success) {
        navigate(`/message/${psychic._id}`, {
          state: { chatSession: response.data.chatSession, psychic, fromHome: true, timestamp: Date.now() }
        });
      } else {
        toast.error(response.data.message || "Failed to start chat.");
        navigate(`/message/${psychic._id}`, { state: { psychic, fromHome: true } });
      }
    } catch (error) {
      toast.info("Connecting to chat...");
      navigate(`/message/${psychic._id}`, { state: { psychic, fromHome: true } });
    } finally {
      setIsSubmitting(false);
    }
  };

  const initiateAudioCall = async (psychic) => {
    if (!user) {
      toast.error("Please log in to start a call");
      navigate("/login");
      return;
    }

    const psychicStatus = getPsychicStatus(psychic._id);
    if (psychicStatus !== 'online' && psychicStatus !== 'away') {
      toast.error(`This psychic is currently ${psychicStatus}. Please try again later.`);
      return;
    }

    setIsSubmitting(true);
    try {
      const token = localStorage.getItem("accessToken");
      const response = await axios.post(
        `${import.meta.env.VITE_BASE_URL}/api/calls/initiate/${psychic._id}`,
        {},
        { headers: { Authorization: `Bearer ${token}` }, withCredentials: true }
      );

      if (response.data.success) {
        const { callRequestId, callSessionId, roomName, expiresAt, isFreeSession } = response.data.data;
        navigate(`/audio-call/${callSessionId}`, {
          state: { callSessionId, callRequestId, roomName, psychic, isFreeSession, expiresAt, user, fromHome: true, status: 'initiated' }
        });
        toast.success("Call initiated! Waiting for psychic to accept...");
      } else {
        toast.error(response.data.message || "Failed to initiate call");
      }
    } catch (error) {
      if (error.response?.status === 400 && error.response?.data?.message?.includes('already have an active call')) {
        toast.error("You already have an active call. Please end it first.");
      } else if (error.response?.status === 403) {
        toast.error("Insufficient credits to start a call.");
      } else {
        toast.error(error.response?.data?.message || "Failed to start audio call");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (contentLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ backgroundColor: colors.softIvory }}>
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: colors.antiqueGold }} />
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ backgroundColor: colors.softIvory }}>
      {/* Hero Section */}
      <div
        className="relative py-24 px-4 overflow-hidden"
        style={{
          backgroundColor: colors.deepPurple,
          background: `linear-gradient(135deg, ${colors.darkPurple} 0%, ${colors.deepPurple} 100%)`
        }}
      >
        <div className="absolute inset-0 overflow-hidden">
          {[...Array(3)].map((_, i) => (
            <motion.div
              key={i}
              className="absolute rounded-full opacity-5"
              style={{
                width: `${200 + i * 100}px`,
                height: `${200 + i * 100}px`,
                background: `radial-gradient(circle, ${colors.antiqueGold} 0%, transparent 70%)`,
                top: `${20 + i * 30}%`,
                left: `${10 + i * 20}%`,
              }}
              animate={{ scale: [1, 1.2, 1], rotate: [0, 360] }}
              transition={{ duration: 20 + i * 5, repeat: Infinity, ease: "linear" }}
            />
          ))}
        </div>

        <div className="relative max-w-7xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            <motion.div
              initial={{ opacity: 0, x: -20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8 }}
              className="text-left"
            >
              <div className="inline-flex items-center gap-2 mb-6 px-4 py-2 rounded-full"
                style={{ backgroundColor: colors.antiqueGold + "20", color: colors.antiqueGold }}>
                <Sparkles className="h-4 w-4" />
                <span className="text-sm font-medium">
                  {homeContent?.hero?.badge || "Trusted by Thousands Worldwide"}
                </span>
              </div>

              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold mb-6 leading-tight">
                <span className="block" style={{ color: colors.softIvory }}>
                  {homeContent?.hero?.title?.line1 || "Discover Your"}
                </span>
                <span style={{
                  background: `linear-gradient(135deg, ${colors.antiqueGold}, #FFD700)`,
                  WebkitBackgroundClip: "text",
                  WebkitTextFillColor: "transparent"
                }}>
                  {homeContent?.hero?.title?.line2 || "Spiritual Path"}
                </span>
              </h1>

              <p className="text-xl mb-8 opacity-90 leading-relaxed" style={{ color: colors.softIvory }}>
                {homeContent?.hero?.description || "Connect with gifted, certified psychics for personalized guidance, clarity, and spiritual growth."}
              </p>

              <div className="flex flex-col sm:flex-row gap-4 mb-12">
                <Button
                  size="lg"
                  className="rounded-full px-8 py-6 text-lg font-semibold transition-all hover:scale-105 shadow-lg"
                  style={{
                    backgroundColor: colors.antiqueGold,
                    color: colors.deepPurple,
                    boxShadow: `0 10px 40px ${colors.antiqueGold}40`
                  }}
                  onClick={() => {
                    if (user) {
                      if (humanPsychics.length > 0) handlePsychicSelect(humanPsychics[0]);
                      else toast.info("No psychics available at the moment");
                    } else {
                      navigate("/login");
                    }
                  }}
                >
                  <Sparkles className="mr-3 h-5 w-5" />
                  {homeContent?.hero?.buttons?.primary?.text || "Start Chatting Now"}
                </Button>

                <Button
                  size="lg"
                  variant="outline"
                  className="rounded-full px-8 py-6 text-lg font-semibold border-2 transition-all hover:scale-105"
                  style={{ borderColor: colors.antiqueGold, color: colors.softIvory, backgroundColor: "transparent" }}
                  onClick={() => navigate("/register")}
                >
                  <Heart className="mr-3 h-5 w-5" />
                  {homeContent?.hero?.buttons?.secondary?.text || "Begin Free Trial"}
                </Button>
              </div>

              <div className="flex flex-wrap gap-6 items-center">
                {homeContent?.hero?.trustIndicators?.map((indicator, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <div className="flex">
                      {indicator.icon === 'star' && [...Array(5)].map((_, i) => (
                        <Star key={i} className="h-4 w-4" style={{ color: colors.antiqueGold, fill: colors.antiqueGold }} />
                      ))}
                      {indicator.icon === 'users' && <Users className="h-4 w-4" style={{ color: colors.antiqueGold }} />}
                      {indicator.icon === 'globe' && <Globe className="h-4 w-4" style={{ color: colors.antiqueGold }} />}
                    </div>
                    <span className="text-sm" style={{ color: colors.softIvory + "CC" }}>{indicator.text}</span>
                  </div>
                ))}
                {!homeContent?.hero?.trustIndicators && (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex">
                        {[...Array(5)].map((_, i) => (
                          <Star key={i} className="h-4 w-4" style={{ color: colors.antiqueGold, fill: colors.antiqueGold }} />
                        ))}
                      </div>
                      <span className="text-sm" style={{ color: colors.softIvory + "CC" }}>4.9/5 Rating</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Users className="h-4 w-4" style={{ color: colors.antiqueGold }} />
                      <span className="text-sm" style={{ color: colors.softIvory + "CC" }}>10,000+ Satisfied Clients</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Globe className="h-4 w-4" style={{ color: colors.antiqueGold }} />
                      <span className="text-sm" style={{ color: colors.softIvory + "CC" }}>Global Community</span>
                    </div>
                  </>
                )}
              </div>
            </motion.div>

            {/* Hero Featured Psychic Card */}
            <motion.div
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.8, delay: 0.2 }}
              className="relative"
            >
              <div className="relative rounded-3xl overflow-hidden shadow-2xl"
                style={{ backgroundColor: colors.darkPurple, border: `2px solid ${colors.antiqueGold}` }}>
                <div className="absolute inset-0 opacity-10"
                  style={{ background: `linear-gradient(45deg, ${colors.antiqueGold}, transparent)` }} />

                {humanPsychics[0] && (
                  <div className="p-8">
                    <div className="flex items-center gap-4 mb-6">
                      <div className="relative">
                        <div className="w-20 h-20 rounded-full overflow-hidden border-4" style={{ borderColor: colors.antiqueGold }}>
                          <img src={humanPsychics[0].image} alt={humanPsychics[0].name} className="w-full h-full object-cover" />
                        </div>
                        <div className="absolute -bottom-2 -right-2 w-10 h-10 rounded-full flex items-center justify-center"
                          style={{ backgroundColor: colors.antiqueGold }}>
                          <Award className="h-5 w-5" style={{ color: colors.deepPurple }} />
                        </div>
                      </div>
                      <div>
                        <h3 className="text-xl font-bold" style={{ color: colors.softIvory }}>{humanPsychics[0].name}</h3>
                        <p className="text-sm" style={{ color: colors.antiqueGold }}>
                          {homeContent?.hero?.featuredPsychic?.title || "Top-Rated Psychic"}
                        </p>
                        <div className="flex items-center mt-1">
                          <Star className="h-3 w-3" style={{ color: colors.antiqueGold, fill: colors.antiqueGold }} />
                          <span className="text-xs ml-1" style={{ color: colors.softIvory + "CC" }}>
                            {humanPsychics[0].rating?.avgRating?.toFixed(1) || "5.0"} · {humanPsychics[0].rating?.totalReviews || "100+"} readings
                          </span>
                        </div>
                      </div>
                    </div>
                    <p className="text-sm mb-6" style={{ color: colors.softIvory + "CC" }}>
                      {homeContent?.hero?.featuredPsychic?.quote ||
                        `"I've helped over 500 clients find clarity and direction in their lives."`}
                    </p>
                    <Button
                      className="w-full rounded-full py-4"
                      style={{ backgroundColor: colors.antiqueGold, color: colors.deepPurple }}
                      onClick={() => handlePsychicSelect(humanPsychics[0])}
                      disabled={!user || isSubmitting}
                    >
                      <MessageCircle className="mr-2 h-5 w-5" />
                      Start Chat with {humanPsychics[0].name.split(" ")[0]}
                    </Button>
                  </div>
                )}
              </div>

              <motion.div
                className="absolute -top-4 -right-4 bg-white p-4 rounded-xl shadow-lg"
                animate={{ y: [0, -10, 0] }}
                transition={{ duration: 2, repeat: Infinity }}
                style={{ border: `2px solid ${colors.antiqueGold}` }}
              >
                <div className="flex items-center gap-2">
                  <Zap className="h-5 w-5" style={{ color: colors.antiqueGold }} />
                  <div>
                    <div className="font-bold text-sm" style={{ color: colors.deepPurple }}>Live Availability</div>
                    <div className="text-xs" style={{ color: colors.deepPurple + "CC" }}>Connect instantly</div>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          </div>
        </div>
      </div>

      {/* Trust & Security Section */}
      <div className="py-12 px-4" style={{ backgroundColor: colors.lightGold }}>
        <div className="max-w-7xl mx-auto">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            {(homeContent?.trustSection?.items || [
              { icon: "shield", title: "100% Secure", description: "End-to-end encryption" },
              { icon: "lock", title: "Private", description: "Confidential sessions" },
              { icon: "check-circle", title: "Verified", description: "Certified psychics" },
              { icon: "clock", title: "24/7 Support", description: "Always available" }
            ]).map((item, idx) => (
              <div key={idx} className="text-center p-4">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-full mb-3"
                  style={{ backgroundColor: colors.deepPurple + "20", color: colors.deepPurple }}>
                  {item.icon === 'shield' && <Shield />}
                  {item.icon === 'lock' && <Lock />}
                  {item.icon === 'check-circle' && <CheckCircle />}
                  {item.icon === 'clock' && <Clock />}
                </div>
                <h4 className="font-bold text-lg mb-1" style={{ color: colors.deepPurple }}>{item.title}</h4>
                <p className="text-sm" style={{ color: colors.deepPurple + "CC" }}>{item.description}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Featured Psychics Section */}
      <div className="max-w-7xl mx-auto px-4 py-16">
        <div className="text-center mb-12">
          <div className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full"
            style={{ backgroundColor: colors.antiqueGold + "20", color: colors.antiqueGold }}>
            <Award className="h-4 w-4" />
            <span className="text-sm font-medium">
              {homeContent?.featuredSection?.badge || "Our Human Psychics"}
            </span>
          </div>
          <h2 className="text-4xl font-bold mb-4" style={{ color: colors.deepPurple }}>
            {homeContent?.featuredSection?.title || "Meet Our Top-Rated Psychics"}
          </h2>
          <p className="text-lg max-w-2xl mx-auto" style={{ color: colors.deepPurple + "CC" }}>
            {homeContent?.featuredSection?.description || "Carefully selected for their exceptional accuracy, empathy, and client satisfaction"}
          </p>
        </div>

        <Tabs defaultValue="active">
          <TabsContent value="active">
            {isLoadingHumanPsychics ? (
              <div className="flex justify-center p-12">
                <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: colors.antiqueGold }} />
              </div>
            ) : humanPsychicsError ? (
              <div className="text-center p-8">
                <p style={{ color: colors.deepPurple }}>{humanPsychicsError}</p>
              </div>
            ) : humanPsychics.length === 0 ? (
              <p className="text-center p-8" style={{ color: colors.deepPurple + "CC" }}>No human psychics available at the moment.</p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
                {humanPsychics.slice(0, showing).map((psychic, i) => {
                  const psychicStatus = getPsychicStatus(psychic._id);
                  const gender = psychic.gender ? psychic.gender.charAt(0).toUpperCase() + psychic.gender.slice(1) : "";
                  const experience = psychic.experience || "0";
                  const specialization = psychic.specialization || psychic.category || "Psychic";
                  const responseTime = psychic.responseTime !== undefined && psychic.responseTime !== null
                    ? `${psychic.responseTime} min` : "Instant";
                  const memberSince = psychic.createdAt ? new Date(psychic.createdAt).toLocaleDateString('en-US', { month: 'short', year: 'numeric' }) : "Recently";
                  const category = psychic.category || "Reading";

                  const statusConfig = {
                    online:  { color: '#10b981', label: 'Online',  bg: '#10b98110', glow: '#10b98140' },
                    away:    { color: '#f59e0b', label: 'Away',    bg: '#f59e0b10', glow: '#f59e0b40' },
                    busy:    { color: '#f97316', label: 'Busy',    bg: '#f9731610', glow: '#f9731640' },
                    offline: { color: '#9ca3af', label: 'Offline', bg: '#9ca3af10', glow: '#9ca3af40' },
                  };
                  const status = statusConfig[psychicStatus] || statusConfig.offline;

                  return (
                    <motion.div
                      key={psychic._id || i}
                      initial={{ opacity: 0, y: 30 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.1, duration: 0.5, ease: [0.23, 1, 0.32, 1] }}
                      className="relative group h-full"
                    >
                      <div
                        className="absolute -inset-0.5 rounded-3xl opacity-0 group-hover:opacity-100 blur-xl transition-all duration-500"
                        style={{ background: `radial-gradient(circle at 30% 30%, ${colors.antiqueGold}40, transparent 70%)` }}
                      />

                      <div
                        className="relative bg-white rounded-2xl overflow-hidden transition-all duration-300 h-full flex flex-col"
                        style={{
                          border: `1px solid ${colors.antiqueGold}20`,
                          boxShadow: `0 4px 20px ${colors.deepPurple}0d, 0 2px 8px ${colors.antiqueGold}10`,
                        }}
                      >
                        {/* Header */}
                        <div className="h-16 bg-gradient-to-r from-[#2B1B3F] to-[#1A1129] relative overflow-hidden">
                          <div className="absolute inset-0 opacity-10">
                            <div className="absolute -right-10 -top-10 w-40 h-40 rounded-full bg-white/10" />
                            <div className="absolute -left-10 -bottom-10 w-32 h-32 rounded-full bg-white/5" />
                          </div>
                          {/* Status badge in header */}
                          <div className="absolute bottom-3 right-4">
                            <div
                              className="flex items-center gap-1.5 px-3 py-1 rounded-full backdrop-blur-sm"
                              style={{ backgroundColor: `${status.color}20`, border: `1px solid ${status.color}30` }}
                            >
                              <span className="relative flex h-2 w-2">
                                <span
                                  className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75"
                                  style={{ backgroundColor: status.color }}
                                />
                                <span
                                  className="relative inline-flex rounded-full h-2 w-2"
                                  style={{ backgroundColor: status.color }}
                                />
                              </span>
                              <span className="text-xs font-medium" style={{ color: status.color }}>
                                {status.label}
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Profile */}
                        <div className="relative px-5">
                          <div className="absolute -top-10 left-5">
                            <div className="relative">
                              <div
                                className="w-20 h-20 rounded-2xl overflow-hidden ring-4 ring-white shadow-xl"
                                style={{ border: `2px solid ${colors.antiqueGold}` }}
                              >
                                <img src={psychic.image} alt={psychic.name} className="w-full h-full object-cover" />
                              </div>
                              {psychic.isVerified && (
                                <div className="absolute -bottom-1 -right-1 bg-emerald-500 rounded-full p-1 ring-2 ring-white">
                                  <CheckCircle className="h-3.5 w-3.5 text-white" />
                                </div>
                              )}
                            </div>
                          </div>

                          <div className="ml-24 pt-3">
                            <div className="flex items-start justify-between">
                              <div className="min-w-0 flex-1">
                                <h3 className="font-bold text-lg leading-tight truncate" style={{ color: colors.deepPurple }}>
                                  {psychic.name}
                                </h3>
                                <p className="text-xs mt-0.5 truncate" style={{ color: colors.deepPurple + "B3" }}>
                                  {specialization}
                                </p>
                              </div>
                              <div className="flex-shrink-0 ml-2">
                                <div className="px-3 py-1.5 rounded-xl text-center" style={{ backgroundColor: colors.deepPurple }}>
                                  <div className="text-sm font-bold leading-none" style={{ color: colors.antiqueGold }}>
                                    ${(psychic.ratePerMin || 1.00).toFixed(2)}
                                  </div>
                                  <div className="text-[8px] mt-0.5 opacity-70" style={{ color: colors.softIvory }}>/min</div>
                                </div>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 mt-2">
                              <div className="flex gap-0.5">
                                {Array(5).fill(0).map((_, j) => (
                                  <Star key={j} className="h-3.5 w-3.5" style={{
                                    color: j < Math.round(psychic.averageRating || 4.5) ? colors.antiqueGold : "#E5E7EB",
                                    fill: j < Math.round(psychic.averageRating || 4.5) ? colors.antiqueGold : "transparent"
                                  }} />
                                ))}
                              </div>
                              <span className="text-xs font-medium" style={{ color: colors.deepPurple }}>
                                {(psychic.averageRating || 4.5).toFixed(1)}
                              </span>
                              <span className="text-[10px]" style={{ color: colors.deepPurple + "99" }}>
                                ({psychic.totalRatings || 0})
                              </span>
                            </div>
                          </div>
                        </div>

                        {/* Badges */}
                        <div className="flex flex-wrap gap-1.5 px-5 mt-4">
                          <span className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-medium"
                            style={{ backgroundColor: colors.antiqueGold + "12", color: colors.antiqueGold, border: `1px solid ${colors.antiqueGold}25` }}>
                            {category}
                          </span>
                          <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-[11px] font-medium"
                            style={{ backgroundColor: colors.deepPurple + "08", color: colors.deepPurple, border: `1px solid ${colors.deepPurple}15` }}>
                            <User className="h-3 w-3" />Human
                          </span>
                          {gender && (
                            <span className="inline-flex items-center px-3 py-1 rounded-full text-[11px] font-medium"
                              style={{ backgroundColor: colors.lightGold + "50", color: colors.deepPurple, border: `1px solid ${colors.antiqueGold}25` }}>
                              {gender}
                            </span>
                          )}
                        </div>

                        {/* Stats */}
                        <div className="grid grid-cols-3 gap-px mx-5 mt-4 rounded-xl overflow-hidden"
                          style={{ backgroundColor: colors.antiqueGold + "15" }}>
                          <div className="py-2.5 text-center bg-white/80">
                            <div className="text-xs font-semibold" style={{ color: colors.deepPurple }}>{responseTime}</div>
                            <div className="text-[9px] mt-0.5" style={{ color: colors.deepPurple + "99" }}>Response</div>
                          </div>
                          <div className="py-2.5 text-center bg-white/80">
                            <div className="text-xs font-semibold" style={{ color: colors.deepPurple }}>
                              {experience === "0" ? "New" : `${experience}y`}
                            </div>
                            <div className="text-[9px] mt-0.5" style={{ color: colors.deepPurple + "99" }}>Experience</div>
                          </div>
                          <div className="py-2.5 text-center bg-white/80">
                            <div className="text-xs font-semibold" style={{ color: colors.deepPurple }}>{memberSince}</div>
                            <div className="text-[9px] mt-0.5" style={{ color: colors.deepPurple + "99" }}>Joined</div>
                          </div>
                        </div>

                        {/* Bio */}
                        <div className="mx-5 mt-4 p-3 rounded-xl" style={{ backgroundColor: colors.softIvory + "80" }}>
                          <p className="text-[11px] leading-relaxed line-clamp-2" style={{ color: colors.deepPurple + "CC" }}>
                            {psychic.bio || `Specializes in ${category.toLowerCase()} guidance. Compassionate and insightful readings.`}
                          </p>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 px-5 py-4 mt-auto border-t" style={{ borderColor: colors.antiqueGold + "15" }}>
                          <Button
                            onClick={() => {
                              if (!user) { toast.error("Please log in"); navigate("/login"); return; }
                              handlePsychicSelect(psychic);
                            }}
                            disabled={isSubmitting || psychicStatus === 'offline' || psychicStatus === 'busy'}
                            className="flex-1 h-9 rounded-xl text-xs font-semibold gap-1.5 transition-all hover:scale-105"
                            style={{
                              backgroundColor: colors.deepPurple,
                              color: colors.softIvory,
                              opacity: (isSubmitting || psychicStatus === 'offline' || psychicStatus === 'busy') ? 0.5 : 1
                            }}
                          >
                            <MessageCircle className="h-3.5 w-3.5" />Chat
                          </Button>

                          <Button
                            onClick={() => {
                              if (!user) { toast.error("Please log in"); navigate("/login"); return; }
                              initiateAudioCall(psychic);
                            }}
                            disabled={isSubmitting || psychicStatus === 'offline' || psychicStatus === 'busy'}
                            className="flex-1 h-9 rounded-xl text-xs font-semibold gap-1.5 transition-all hover:scale-105"
                            style={{
                              backgroundColor: colors.antiqueGold,
                              color: colors.deepPurple,
                              opacity: (isSubmitting || psychicStatus === 'offline' || psychicStatus === 'busy') ? 0.5 : 1
                            }}
                          >
                            <Phone className="h-3.5 w-3.5" />Call
                          </Button>

                          <Button
                            variant="outline"
                            onClick={() => navigate(`/psychic/${psychic._id}`)}
                            className="flex-1 h-9 rounded-xl text-xs font-semibold gap-1.5 transition-all hover:scale-105"
                            style={{ borderColor: colors.antiqueGold + "40", color: colors.deepPurple, backgroundColor: 'white' }}
                          >
                            <User className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                  );
                })}
              </div>
            )}

            {humanPsychics.length > 6 && (
              <div className="flex justify-center items-center">
                <Button
                  onClick={handleShowMore}
                  size="lg"
                  className="rounded-full px-8 py-6 text-lg font-semibold transition-all hover:scale-105 shadow-lg"
                  style={{ backgroundColor: colors.antiqueGold, color: colors.deepPurple, boxShadow: `0 10px 40px ${colors.antiqueGold}40` }}
                >
                  <Sparkles className="mr-3 h-5 w-5" />
                  View All Psychics ({humanPsychics.length - 6} more)
                </Button>
              </div>
            )}

            {humanPsychics.length === 6 && (
              <div className="flex justify-center items-center">
                <Button
                  onClick={() => navigate("/psychics")}
                  size="lg"
                  className="rounded-full px-8 py-6 text-lg font-semibold transition-all hover:scale-105 shadow-lg"
                  style={{ backgroundColor: colors.antiqueGold, color: colors.deepPurple, boxShadow: `0 10px 40px ${colors.antiqueGold}40` }}
                >
                  <Sparkles className="mr-3 h-5 w-5" />
                  View All Psychics
                </Button>
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* Features Section */}
      <div className="py-20 px-4" style={{
        backgroundColor: colors.deepPurple,
        background: `linear-gradient(135deg, ${colors.darkPurple} 0%, ${colors.deepPurple} 100%)`
      }}>
        <div className="max-w-7xl mx-auto">
          <div className="text-center mb-16">
            <div className="inline-flex items-center gap-2 mb-4 px-4 py-2 rounded-full"
              style={{ backgroundColor: colors.antiqueGold + "20", color: colors.antiqueGold }}>
              <Sparkles className="h-4 w-4" />
              <span className="text-sm font-medium">
                {homeContent?.featuresSection?.badge || "Why HecateVoyance Stands Out"}
              </span>
            </div>
            <h2 className="text-4xl font-bold mb-6" style={{ color: colors.softIvory }}>
              {homeContent?.featuresSection?.title || "The Ultimate Spiritual Guidance Platform"}
            </h2>
            <p className="text-lg max-w-3xl mx-auto" style={{ color: colors.softIvory + "CC" }}>
              {homeContent?.featuresSection?.description || "We combine ancient wisdom with modern technology to provide authentic, transformative experiences"}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {(homeContent?.featuresSection?.features || [
              { icon: "🎯", title: "Precision Matching", description: "Our advanced algorithm connects you with psychics whose specialties align perfectly with your needs.", features: ["Skill-based matching", "Personality compatibility", "Client success rates"] },
              { icon: "🔮", title: "Diverse Modalities", description: "Access specialists in tarot, astrology, mediumship, numerology, and more.", features: ["Multiple reading types", "Specialized experts", "Cross-disciplinary insights"] },
              { icon: "💖", title: "Empathetic Connections", description: "Build meaningful relationships with psychics who genuinely care.", features: ["Compassionate listeners", "Non-judgmental space", "Personalized approach"] },
              { icon: "🛡️", title: "Rigorous Vetting", description: "Every psychic undergoes thorough screening, testing, and ongoing quality assessment.", features: ["Background checks", "Skill verification", "Client feedback review"] },
              { icon: "⚡", title: "Instant Access", description: "Connect with available psychics immediately or schedule at your convenience.", features: ["Live availability", "Flexible scheduling", "Global timezone support"] },
              { icon: "📈", title: "Growth-Focused", description: "Tools and resources to track your spiritual development.", features: ["Session records", "Progress insights", "Personalized recommendations"] }
            ]).map((feature, index) => (
              <motion.div
                key={index}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: index * 0.1 }}
                className="p-6 rounded-2xl group hover:scale-105 transition-transform duration-300"
                style={{ backgroundColor: colors.deepPurple + "DD", border: `1px solid ${colors.antiqueGold}33`, backdropFilter: "blur(10px)" }}
              >
                <div className="text-4xl mb-4">{feature.icon}</div>
                <h3 className="text-xl font-bold mb-3" style={{ color: colors.softIvory }}>{feature.title}</h3>
                <p className="mb-4" style={{ color: colors.softIvory + "CC" }}>{feature.description}</p>
                <ul className="space-y-2">
                  {feature.features.map((item, idx) => (
                    <li key={idx} className="flex items-center gap-2 text-sm">
                      <div className="w-1 h-1 rounded-full" style={{ backgroundColor: colors.antiqueGold }} />
                      <span style={{ color: colors.softIvory + "CC" }}>{item}</span>
                    </li>
                  ))}
                </ul>
              </motion.div>
            ))}
          </div>
        </div>
      </div>

      {/* CTA Section */}
      <div className="py-20 px-4" style={{ backgroundColor: colors.softIvory }}>
        <div className="max-w-4xl mx-auto text-center">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true }}
            className="relative rounded-3xl p-8 md:p-12 overflow-hidden"
            style={{
              backgroundColor: colors.deepPurple,
              background: `linear-gradient(135deg, ${colors.deepPurple}, ${colors.darkPurple})`,
              border: `2px solid ${colors.antiqueGold}`
            }}
          >
            <div className="absolute top-0 left-0 w-full h-1" style={{ backgroundColor: colors.antiqueGold }} />

            <h2 className="text-3xl md:text-4xl font-bold mb-6" style={{ color: colors.softIvory }}>
              {homeContent?.ctaSection?.title || "Ready to Begin Your Spiritual Journey?"}
            </h2>
            <p className="text-lg mb-8 max-w-2xl mx-auto" style={{ color: colors.softIvory + "CC" }}>
              {homeContent?.ctaSection?.description || "Join thousands who have found clarity, direction, and peace through authentic psychic connections"}
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button
                size="lg"
                className="rounded-full px-8 py-6 text-lg font-semibold shadow-xl"
                style={{ backgroundColor: colors.antiqueGold, color: colors.deepPurple }}
                onClick={() => {
                  if (user) {
                    if (humanPsychics.length > 0) handlePsychicSelect(humanPsychics[0]);
                    else toast.info("No psychics available at the moment");
                  } else {
                    navigate("/login");
                  }
                }}
              >
                {homeContent?.ctaSection?.button?.text || "Start Chatting Now"}
              </Button>
            </div>

            <p className="text-sm mt-8" style={{ color: colors.softIvory + "80" }}>
              {homeContent?.ctaSection?.footer || "No credit card required for trial · Cancel anytime · 100% satisfaction guarantee"}
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
};

export default Home;
