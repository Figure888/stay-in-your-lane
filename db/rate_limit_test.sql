select (check_rate_limit('t2', 2, 60)->>'allowed') as call_1,
       (check_rate_limit('t2', 2, 60)->>'allowed') as call_2,
       (check_rate_limit('t2', 2, 60)->>'allowed') as call_3_should_be_false,
       (check_rate_limit('t2', 2, 60)->>'retryAfter') as retry_after;
