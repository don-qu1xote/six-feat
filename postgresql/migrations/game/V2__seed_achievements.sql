
INSERT INTO game_achievements (code, title, descr) VALUES
    ('first_win', 'First Blood', 'Complete your first challenge'),
    ('perfect_solve', 'Perfect Chain', 'Match the ideal path exactly — no wasted hops'),
    ('speedrunner', 'Speedrunner', 'Solve a challenge in under 15 seconds'),
    ('veteran', 'Veteran', 'Play 50 games'),
    ('elo_1500', 'Rising Star', 'Reach 1500 Elo')
ON CONFLICT (code) DO NOTHING;
