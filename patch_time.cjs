const fs = require('fs');
let code = fs.readFileSync('src/App.tsx', 'utf8');

const regex = /\/\/ Game Time state\n  const \[gameTimeMinutes, setGameTimeMinutes\] = useState<number>\(8 \* 60\); \/\/ Starts at 08:00 AM\n  const \[gameTimeSpeed, setGameTimeSpeed\] = useState<number>\(1\); \/\/ 0=pause, 1=1x \(1min\/s\), 2=2x, 3=3x/;

code = code.replace(regex, `// Game Time state
  const [gameTimeMinutes, setGameTimeMinutes] = useState<number>(8 * 60); // Starts at 08:00 AM
  const [gameTimeSpeed, setGameTimeSpeed] = useState<number>(1); // 0=pause, 1=1x (1min/s), 2=2x, 3=3x

  // Game Time Engine
  useEffect(() => {
    if (gameTimeSpeed === 0 || gameSetupMode !== 'in_game') return;

    let multiplier = 1;
    if (gameTimeSpeed === 2) multiplier = 2; // 2 in-game mins per second
    if (gameTimeSpeed === 3) multiplier = 5; // 5 in-game mins per second

    const interval = setInterval(() => {
      setGameTimeMinutes(prev => (prev + multiplier) % (24 * 60)); // Loop at midnight
    }, 1000);

    return () => clearInterval(interval);
  }, [gameTimeSpeed, gameSetupMode]);`);

fs.writeFileSync('src/App.tsx', code);
console.log("Success");
