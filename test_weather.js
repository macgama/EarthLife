async function test() {
  const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current_weather=true');
  const data = await res.json();
  console.log(data);
}
test();
